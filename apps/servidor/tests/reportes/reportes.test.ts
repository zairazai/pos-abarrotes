import { expect } from 'chai';
import { randomUUID } from 'node:crypto';
import sinon from 'sinon';
import { Decimal } from '@pos/compartido';
import { fuenteDatos } from '../../src/infraestructura/base-datos/fuente';
import { LoteEntidad } from '../../src/modulos/inventario/inventario.tablas';
import { AHORA, appDePrueba, type Api } from '../ayuda';

/**
 * Jornada del 2026-10-17 (reloj de las pruebas):
 * - Entrada de 10 frijoles a $30 (el costo del producto pasa de $31 a $30) y 5 kg de queso de
 *   ejemplo, sin nota, que usan el costo del producto ($100). El arroz nunca se vende.
 * - Folio 1 (Dueño): 3 frijoles + 0.5 kg de queso = $195.50 en efectivo.
 * - Folio 2 (Dueño): 1 frijol con tarjeta. Folio 3 (Empleado): 1 frijol en efectivo.
 * - Se devuelve 1 frijol del folio 1, se tira 1 frijol como merma y el Dueño cancela una venta en
 *   curso. La caja cierra cuadrada con $695.50.
 */
async function jornada() {
  const { api, empleado, empleadoId } = await appDePrueba();
  const [categoria] = await fuenteDatos.query(`SELECT id FROM categoria WHERE nombre = 'Abarrotes'`);
  const [dueno] = await fuenteDatos.query(`SELECT id FROM usuario WHERE rol = 'DUENO'`);
  const producto = async (codigo: string, nombre: string, unidad: string, precio: string, costo: string) =>
    (
      await api
        .post('/api/v1/productos')
        .send({ codigo, nombre, unidad, precio, costo, existenciaMinima: '0', categoriaId: categoria.id })
        .expect(201)
    ).body.data.id as string;
  const frijol = await producto('FRI-1', 'Frijol negro 1 kg', 'PIEZA', '38.50', '31.00');
  const queso = await producto('QUE-1', 'Queso fresco', 'KG', '160.00', '100.00');
  const arroz = await producto('ARR-1', 'Arroz 1 kg', 'PIEZA', '25.00', '20.00');

  // Sin caja abierta, la entrada se queda sin pago.
  const proveedor = await api.post('/api/v1/proveedores').send({ nombre: 'La Costeña' }).expect(201);
  await api
    .post('/api/v1/inventario/entradas')
    .send({
      proveedorId: proveedor.body.data.id,
      folioNota: 'N-1',
      renglones: [{ productoId: frijol, cantidad: '10', costoUnitario: '30', caducidad: '2026-12-01' }],
    })
    .expect(201);
  await fuenteDatos.getRepository(LoteEntidad).insert({
    id: randomUUID(),
    productoId: queso,
    caducidad: null,
    existencia: new Decimal(5),
    cantidadInicial: new Decimal(5),
    origen: 'EJEMPLO',
    creadoEn: new Date(),
  });

  await api
    .post('/api/v1/caja/apertura')
    .send({ fondoInicial: { B100: 5 } })
    .expect(201);
  const cobrar = (quien: Api, iniciadaPor: string, renglones: object[], pagos: object[]) =>
    quien
      .post('/api/v1/ventas')
      .set('Idempotency-Key', randomUUID())
      .send({ iniciadaPor, renglones, pagos })
      .expect(201);
  await cobrar(
    api,
    dueno.id,
    [
      { productoId: frijol, cantidad: '3' },
      { productoId: queso, cantidad: '0.5' },
    ],
    [{ metodo: 'EFECTIVO', monto: '200' }],
  );
  await cobrar(
    api,
    dueno.id,
    [{ productoId: frijol, cantidad: '1' }],
    [{ metodo: 'TARJETA', monto: '38.50', referencia: '4321' }],
  );
  await cobrar(
    empleado,
    empleadoId,
    [{ productoId: frijol, cantidad: '1' }],
    [{ metodo: 'EFECTIVO', monto: '40' }],
  );

  await api
    .post('/api/v1/devoluciones')
    .send({
      folio: 1,
      motivo: 'Venía abierto',
      reembolso: 'EFECTIVO',
      renglones: [{ renglon: 1, cantidad: '1', destino: 'INVENTARIO' }],
    })
    .expect(201);
  await api
    .post('/api/v1/inventario/salidas')
    .send({ tipo: 'MERMA', productoId: frijol, cantidad: '1', motivo: 'Bolsa rota' })
    .expect(201);
  await api
    .post('/api/v1/ventas/canceladas')
    .send({ iniciadaPor: dueno.id, renglones: [{ productoId: arroz, cantidad: '2' }] })
    .expect(201);

  // 500 + 195.50 + 38.50 - 38.50 = 695.50
  await api
    .post('/api/v1/caja/arqueo')
    .send({ conteo: { B500: 1, B100: 1, B50: 1, B20: 2, M5: 1, M050: 1 } })
    .expect(201);
  await api.post('/api/v1/caja/cierre').send({}).expect(200);
  return { api, empleado, frijol, queso, arroz, empleadoId };
}

const reporte = async (api: Api, tipo: string, consulta = '') =>
  (await api.get(`/api/v1/reportes/${tipo}${consulta}`).expect(200)).body;

describe('Reportes del Dueño', () => {
  // La jornada se arma una vez y los reportes solo la consultan.
  let j: Awaited<ReturnType<typeof jornada>>;
  before(async function () {
    this.timeout(30_000);
    // El reloj falso de ganchos.ts solo existe dentro de cada prueba; aquí se pone uno igual.
    const reloj = sinon.useFakeTimers({ now: AHORA, toFake: ['Date'] });
    try {
      j = await jornada();
    } finally {
      reloj.restore();
    }
  });

  it('ventas por día: forma de pago, devoluciones y neto', async () => {
    const { data } = await reporte(j.api, 'ventas');
    expect(data).to.include({ tipo: 'ventas', desde: '2026-10-17', hasta: '2026-10-17' });
    const cifras = {
      ventas: 3,
      total: '272.50',
      efectivo: '234.00',
      tarjeta: '38.50',
      transferencia: '0.00',
      saldoFavor: '0.00',
      devuelto: '38.50',
      neto: '234.00',
    };
    expect(data.dias).to.deep.equal([{ fecha: '2026-10-17', ...cifras }]);
    expect(data.totales).to.deep.equal(cifras);
  });

  it('ganancia: venta menos el costo del lote, o del producto si el lote no tiene nota', async () => {
    const { data } = await reporte(j.api, 'ganancia');
    // Frijol: 5 vendidos - 1 devuelto = 4; $154 de venta contra 4 × $30.
    expect(data.productos).to.deep.equal([
      {
        productoId: j.frijol,
        nombre: 'Frijol negro 1 kg',
        unidad: 'PIEZA',
        cantidad: '4.00',
        venta: '154.00',
        costo: '120.00',
        ganancia: '34.00',
        margen: '22.1',
      },
      {
        productoId: j.queso,
        nombre: 'Queso fresco',
        unidad: 'KG',
        cantidad: '0.50',
        venta: '80.00',
        costo: '50.00',
        ganancia: '30.00',
        margen: '37.5',
      },
    ]);
    expect(data.totales).to.deep.equal({
      venta: '234.00',
      costo: '170.00',
      ganancia: '64.00',
      margen: '27.4',
    });
  });

  it('más y menos vendidos; en los menos aparecen los que no se vendieron', async () => {
    const { data } = await reporte(j.api, 'mas-vendidos');
    expect(
      data.masVendidos.map((v: { nombre: string; cantidad: string }) => [v.nombre, v.cantidad]),
    ).to.deep.equal([
      ['Frijol negro 1 kg', '4.00'],
      ['Queso fresco', '0.50'],
    ]);
    expect(
      data.menosVendidos.map((v: { nombre: string; cantidad: string }) => [v.nombre, v.cantidad]),
    ).to.deep.equal([
      ['Arroz 1 kg', '0.00'],
      ['Queso fresco', '0.50'],
      ['Frijol negro 1 kg', '4.00'],
    ]);
  });

  it('cortes de caja con fondo, esperado, contado y diferencia', async () => {
    const { data } = await reporte(j.api, 'cortes');
    expect(data.cajas).to.deep.equal([
      {
        fecha: '2026-10-17',
        estado: 'CERRADA',
        abiertaPor: 'Dueño',
        cerradaPor: 'Dueño',
        fondoInicial: '500.00',
        esperado: '695.50',
        contado: '695.50',
        diferencia: '0.00',
        justificacion: null,
      },
    ]);
    expect(data.totales).to.deep.equal({ cajas: 1, diferencia: '0.00' });
  });

  it('inventario valorizado al momento', async () => {
    const { data } = await reporte(j.api, 'inventario', '?desde=2026-01-01&hasta=2026-01-31');
    // Siempre es el de hoy, aunque se pida otro periodo.
    expect(data).to.include({ desde: '2026-10-17', hasta: '2026-10-17' });
    expect(
      data.productos.map((p: { nombre: string; existencia: string; valor: string }) => [
        p.nombre,
        p.existencia,
        p.valor,
      ]),
    ).to.deep.equal([
      ['Arroz 1 kg', '0.00', '0.00'],
      ['Frijol negro 1 kg', '5.00', '150.00'], // 10 - 5 vendidos + 1 devuelto - 1 merma, a $30
      ['Queso fresco', '4.50', '450.00'], // sin nota: $100 del producto
    ]);
    expect(data.totales).to.deep.equal({ productos: 3, valor: '600.00' });
  });

  it('mermas y consumo con su costo', async () => {
    const { data } = await reporte(j.api, 'mermas');
    expect(data.salidas).to.have.length(1);
    expect(data.salidas[0]).to.include({
      tipo: 'MERMA',
      nombre: 'Frijol negro 1 kg',
      cantidad: '1.00',
      costo: '30.00',
      motivo: 'Bolsa rota',
      usuario: 'Dueño',
    });
    expect(data.totales).to.deep.equal({
      merma: { registros: 1, costo: '30.00' },
      consumo: { registros: 0, costo: '0.00' },
    });
  });

  it('cancelaciones y devoluciones', async () => {
    const { data } = await reporte(j.api, 'cancelaciones');
    expect(data.canceladas).to.have.length(1);
    expect(data.canceladas[0]).to.include({
      motivo: 'EN_CURSO',
      canceladaPor: 'Dueño',
      renglones: 1,
      total: '50.00',
    });
    expect(data.devoluciones).to.have.length(1);
    expect(data.devoluciones[0]).to.include({
      folio: 1,
      tipo: 'PARCIAL',
      motivo: 'Venía abierto',
      formaReembolso: 'EFECTIVO',
      importe: '38.50',
      usuario: 'Dueño',
    });
    expect(data.totales).to.deep.equal({
      canceladas: 1,
      totalCancelado: '50.00',
      devoluciones: 1,
      totalDevuelto: '38.50',
    });
  });

  it('ventas por empleado', async () => {
    const { data } = await reporte(j.api, 'empleados');
    expect(data.empleados.map((e: object) => ({ ...e, usuarioId: undefined }))).to.deep.equal([
      {
        usuarioId: undefined,
        nombre: 'Dueño',
        ventas: 2,
        total: '234.00',
        cancelaciones: 1,
        devoluciones: 1,
        devuelto: '38.50',
      },
      {
        usuarioId: undefined,
        nombre: 'Empleado de prueba',
        ventas: 1,
        total: '38.50',
        cancelaciones: 0,
        devoluciones: 0,
        devuelto: '0.00',
      },
    ]);
  });

  it('un periodo sin movimientos lo indica (2a)', async () => {
    const res = await reporte(j.api, 'ventas', '?desde=2026-10-01&hasta=2026-10-16');
    expect(res.message).to.equal('Sin datos en el periodo');
    expect(res.data.dias).to.deep.equal([]);
    expect(res.data.totales.total).to.equal('0.00');
  });

  it('revisa el periodo y el tipo de reporte', async () => {
    const invertido = await j.api
      .get('/api/v1/reportes/ventas?desde=2026-10-17&hasta=2026-10-01')
      .expect(422);
    expect(invertido.body.detail).to.include('posterior');
    const largo = await j.api.get('/api/v1/reportes/ventas?desde=2025-01-01&hasta=2026-10-17').expect(422);
    expect(largo.body.detail).to.include('366');
    const fecha = await j.api.get('/api/v1/reportes/ventas?desde=2026-02-30').expect(400);
    expect(fecha.body.errores[0].campo).to.equal('query.desde');
    const tipo = await j.api.get('/api/v1/reportes/utilidades').expect(400);
    expect(tipo.body.errores[0].campo).to.equal('params.tipo');
  });

  it('el Empleado no consulta reportes', async () => {
    await j.empleado.get('/api/v1/reportes/ventas').expect(403);
  });
});
