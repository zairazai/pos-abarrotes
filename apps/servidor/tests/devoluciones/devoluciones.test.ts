import { expect } from 'chai';
import { randomUUID } from 'node:crypto';
import { Decimal } from '@pos/compartido';
import { fuenteDatos } from '../../src/infraestructura/base-datos/fuente';
import { LoteEntidad } from '../../src/modulos/inventario/inventario.tablas';
import { appDePrueba, registrosBitacora, type Api } from '../ayuda';

/** Venta con folio 1: 2 frijoles a 38.50 + 0.5 kg de queso a 160 = 157.00, pagada con 200. */
async function escenario() {
  const { api, empleado } = await appDePrueba();
  await api
    .post('/api/v1/caja/apertura')
    .send({ fondoInicial: { B100: 5 } })
    .expect(201);
  const [categoria] = await fuenteDatos.query(`SELECT id FROM categoria WHERE nombre = 'Abarrotes'`);
  const [dueno] = await fuenteDatos.query(`SELECT id FROM usuario WHERE rol = 'DUENO'`);
  const producto = async (codigo: string, nombre: string, unidad: string, precio: string) =>
    (
      await api
        .post('/api/v1/productos')
        .send({
          codigo,
          nombre,
          unidad,
          precio,
          costo: '1.00',
          existenciaMinima: '0',
          categoriaId: categoria.id,
        })
        .expect(201)
    ).body.data.id as string;
  const frijol = await producto('FRI-1', 'Frijol negro 1 kg', 'PIEZA', '38.50');
  const queso = await producto('QUE-1', 'Queso fresco', 'KG', '160.00');
  const loteFrijol = randomUUID();
  await fuenteDatos.getRepository(LoteEntidad).insert({
    id: loteFrijol,
    productoId: frijol,
    caducidad: '2026-12-01',
    existencia: new Decimal(10),
    cantidadInicial: new Decimal(10),
    origen: 'EJEMPLO',
    creadoEn: new Date(),
  });
  await api
    .post('/api/v1/ventas')
    .set('Idempotency-Key', randomUUID())
    .send({
      iniciadaPor: dueno.id,
      renglones: [
        { productoId: frijol, cantidad: '2' },
        { productoId: queso, cantidad: '0.5' },
      ],
      pagos: [{ metodo: 'EFECTIVO', monto: '200' }],
    })
    .expect(201);
  return { api, empleado, frijol, queso, loteFrijol, duenoId: dueno.id as string };
}

const devolver = (
  api: Api,
  renglones: object[],
  motivo = 'Cliente cambió de opinión',
  reembolso = 'EFECTIVO',
) => api.post('/api/v1/devoluciones').send({ folio: 1, motivo, renglones, reembolso });

const existencia = async (loteId: string) =>
  (await fuenteDatos.getRepository(LoteEntidad).findOneByOrFail({ id: loteId })).existencia.toFixed(2);

const esperado = async (api: Api) =>
  (await api.get('/api/v1/caja/actual').expect(200)).body.data.caja.esperado;

describe('Devoluciones', () => {
  it('muestra la venta del día con lo que aún se puede devolver', async () => {
    const { empleado } = await escenario();
    const res = await empleado.get('/api/v1/devoluciones/folio/1').expect(200);
    expect(res.body.data.venta).to.include({ folio: 1, totalCobrado: '157.00', reembolsado: '0.00' });
    expect(res.body.data.renglones[0]).to.include({
      renglon: 1,
      vendida: '2.00',
      devuelta: '0.00',
      devolvible: '2.00',
      neto: '77.00',
    });
    expect(res.body.data.renglones[1]).to.include({ renglon: 2, unidad: 'KG', devolvible: '0.50' });
  });

  it('el Empleado devuelve una parte: regresa al lote, sale el efectivo y queda en bitácora', async () => {
    const { api, empleado, loteFrijol } = await escenario();
    expect(await existencia(loteFrijol)).to.equal('8.00');

    const res = await devolver(empleado, [{ renglon: 1, cantidad: '1', destino: 'INVENTARIO' }]).expect(201);
    expect(res.body.data).to.include({ folio: 1, tipo: 'PARCIAL', reembolso: '38.50' });
    expect(res.body.data.renglones[0]).to.include({ renglon: 1, cantidad: '1.00', importe: '38.50' });
    expect(await existencia(loteFrijol)).to.equal('9.00');

    // 500 de fondo + 157 de la venta - 38.50 del reembolso.
    expect(await esperado(api)).to.equal('618.50');
    const caja = (await api.get('/api/v1/caja/actual')).body.data.caja;
    expect(caja.movimientos.at(-1)).to.include({
      tipo: 'DEVOLUCION',
      monto: '38.50',
      devolucionId: res.body.data.id,
    });

    const { registros } = await registrosBitacora({ accion: 'DEVOLUCION_REGISTRADA' });
    expect(registros[0]!.despues).to.include({ folio: 1, tipo: 'PARCIAL', reembolso: '38.50' });
    const despues = await empleado.get('/api/v1/devoluciones/folio/1').expect(200);
    expect(despues.body.data.venta.reembolsado).to.equal('38.50');
    expect(despues.body.data.renglones[0]).to.include({ devuelta: '1.00', devolvible: '1.00' });
  });

  it('lo dañado se registra como merma y la existencia no cambia', async () => {
    const { empleado, frijol, loteFrijol } = await escenario();
    await devolver(empleado, [{ renglon: 1, cantidad: '1', destino: 'MERMA' }], 'Bolsa rota').expect(201);
    expect(await existencia(loteFrijol)).to.equal('8.00');
    const [merma] = await fuenteDatos.query(
      `SELECT tipo, lote_id, cantidad, motivo, comentario FROM salida WHERE producto_id = $1`,
      [frijol],
    );
    expect(merma).to.deep.include({
      tipo: 'MERMA',
      lote_id: loteFrijol,
      cantidad: '1.00',
      motivo: 'Devolución del folio 1',
      comentario: 'Bolsa rota',
    });
  });

  it('solo el Dueño devuelve la venta completa y se reembolsa todo lo cobrado', async () => {
    const { api, empleado } = await escenario();
    const todo = [
      { renglon: 1, cantidad: '2', destino: 'INVENTARIO' },
      { renglon: 2, cantidad: '0.5', destino: 'INVENTARIO' },
    ];
    const prohibido = await devolver(empleado, todo).expect(403);
    expect(prohibido.body.detail).to.match(/Solo el Dueño devuelve la venta completa/);
    const [{ n }] = await fuenteDatos.query(`SELECT count(*)::int AS n FROM devolucion`);
    expect(n).to.equal(0);

    const res = await devolver(api, todo).expect(201);
    expect(res.body.data).to.include({ tipo: 'TOTAL', reembolso: '157.00' });
    expect(await esperado(api)).to.equal('500.00');
  });

  it('al devolver lo que quedaba después de una parcial, se reembolsa justo lo que faltaba', async () => {
    const { api, empleado } = await escenario();
    await devolver(empleado, [{ renglon: 1, cantidad: '1', destino: 'INVENTARIO' }]).expect(201);
    const res = await devolver(api, [
      { renglon: 1, cantidad: '1', destino: 'INVENTARIO' },
      { renglon: 2, cantidad: '0.5', destino: 'INVENTARIO' },
    ]).expect(201);
    expect(res.body.data).to.include({ tipo: 'TOTAL', reembolso: '118.50' });
    const otra = await devolver(api, [{ renglon: 1, cantidad: '1', destino: 'INVENTARIO' }]).expect(422);
    expect(otra.body.detail).to.equal('Del renglón 1 solo quedan 0.00 por devolver');
  });

  it('el descuento de un renglón solo cuenta para ese renglón', async () => {
    const { api, frijol, queso, duenoId } = await escenario();
    await api
      .post('/api/v1/ventas')
      .set('Idempotency-Key', randomUUID())
      .send({
        iniciadaPor: duenoId,
        renglones: [
          { productoId: frijol, cantidad: '2', descuento: { tipo: 'MONTO', valor: '7.00' } },
          { productoId: queso, cantidad: '0.5' },
        ],
        pagos: [{ metodo: 'EFECTIVO', monto: '150' }],
      })
      .expect(201);

    const venta = await api.get('/api/v1/devoluciones/folio/2').expect(200);
    expect(venta.body.data.renglones.map((r: { neto: string }) => r.neto)).to.deep.equal(['70.00', '80.00']);
    const res = await api
      .post('/api/v1/devoluciones')
      .send({
        folio: 2,
        motivo: 'No lo quiso',
        renglones: [{ renglon: 2, cantidad: '0.5', destino: 'INVENTARIO' }],
      })
      .expect(201);
    expect(res.body.data.reembolso).to.equal('80.00');
  });

  it('rechaza folios inexistentes y ventas de otro día', async () => {
    const { api, empleado } = await escenario();
    await empleado.get('/api/v1/devoluciones/folio/99').expect(404);
    await fuenteDatos.query(`UPDATE venta SET fecha = fecha - interval '1 day' WHERE folio = 1`);
    const res = await devolver(api, [{ renglon: 1, cantidad: '1', destino: 'INVENTARIO' }]).expect(422);
    expect(res.body.detail).to.match(/del día/);
  });

  it('si no alcanza el efectivo de la caja, no se registra', async () => {
    const { api } = await escenario();
    await api
      .post('/api/v1/caja/movimientos')
      .send({ tipo: 'RETIRO', monto: '650.00', motivo: 'Depósito al banco' })
      .expect(201);
    const res = await devolver(api, [{ renglon: 1, cantidad: '1', destino: 'INVENTARIO' }]).expect(422);
    expect(res.body.detail).to.equal('En caja hay $7.00; no alcanza para reembolsar $38.50');
    const [{ n }] = await fuenteDatos.query(`SELECT count(*)::int AS n FROM devolucion`);
    expect(n).to.equal(0);
  });

  describe('cambio por producto con saldo a favor', () => {
    /** Venta nueva con el saldo como primer pago. */
    const cobrarConSaldo = (api: Api, cuerpo: object) =>
      api.post('/api/v1/ventas').set('Idempotency-Key', randomUUID()).send(cuerpo);

    it('la devolución crea el saldo del día y no saca efectivo de la caja', async () => {
      const { api, empleado } = await escenario();
      const res = await devolver(
        empleado,
        [{ renglon: 1, cantidad: '1', destino: 'INVENTARIO' }],
        'Cambio',
        'SALDO_FAVOR',
      ).expect(201);
      expect(res.body.data).to.include({ formaReembolso: 'SALDO_FAVOR', reembolso: '0.00' });
      expect(res.body.data.saldoFavor.monto).to.equal('38.50');
      expect(await esperado(api)).to.equal('657.00');
      const venta = await empleado.get('/api/v1/devoluciones/folio/1').expect(200);
      expect(venta.body.data.venta.reembolsado).to.equal('38.50');
    });

    it('si la venta nueva cuesta más, el saldo es el primer pago y se paga la diferencia', async () => {
      const { api, empleado, queso, duenoId } = await escenario();
      const dev = await devolver(
        empleado,
        [{ renglon: 1, cantidad: '1', destino: 'INVENTARIO' }],
        'Cambio',
        'SALDO_FAVOR',
      );
      const res = await cobrarConSaldo(empleado, {
        iniciadaPor: duenoId,
        renglones: [{ productoId: queso, cantidad: '0.5' }],
        pagos: [{ metodo: 'EFECTIVO', monto: '50' }],
        saldoFavorId: dev.body.data.saldoFavor.id,
      }).expect(201);
      // 80.00 - 38.50 de saldo = 41.50 en efectivo; paga 50 y recibe 8.50.
      expect(res.body.data).to.include({ total: '80.00', totalCobrado: '80.00', cambio: '8.50' });
      expect(res.body.data.pagos[0]).to.include({ metodo: 'SALDO_FAVOR', monto: '38.50' });
      expect(await esperado(api)).to.equal('698.50');
    });

    it('si cuesta menos, la diferencia se entrega en efectivo de la caja', async () => {
      const { api, frijol, duenoId } = await escenario();
      const dev = await devolver(
        api,
        [{ renglon: 2, cantidad: '0.5', destino: 'MERMA' }],
        'Cambio',
        'SALDO_FAVOR',
      );
      expect(dev.body.data.saldoFavor.monto).to.equal('80.00');
      const res = await cobrarConSaldo(api, {
        iniciadaPor: duenoId,
        renglones: [{ productoId: frijol, cantidad: '1' }],
        pagos: [],
        saldoFavorId: dev.body.data.saldoFavor.id,
      }).expect(201);
      expect(res.body.data).to.include({ total: '38.50', cambio: '41.50' });
      expect(res.body.data.pagos).to.have.length(1);
      // 657 - 41.50 que se entregan.
      expect(await esperado(api)).to.equal('615.50');
    });

    it('el saldo se usa una sola vez y solo el mismo día', async () => {
      const { api, frijol, duenoId } = await escenario();
      const dev = await devolver(
        api,
        [{ renglon: 1, cantidad: '2', destino: 'INVENTARIO' }],
        'Cambio',
        'SALDO_FAVOR',
      );
      const cuerpo = {
        iniciadaPor: duenoId,
        renglones: [{ productoId: frijol, cantidad: '1' }],
        pagos: [],
        saldoFavorId: dev.body.data.saldoFavor.id,
      };
      await cobrarConSaldo(api, cuerpo).expect(201);
      const otra = await cobrarConSaldo(api, cuerpo).expect(409);
      expect(otra.body.detail).to.match(/ya se usó/);

      await fuenteDatos.query(`UPDATE saldo_favor SET venta_id = NULL, fecha = fecha - interval '1 day'`);
      const ayer = await cobrarConSaldo(api, cuerpo).expect(422);
      expect(ayer.body.detail).to.match(/no se guarda para otro día/);
      await cobrarConSaldo(api, { ...cuerpo, saldoFavorId: randomUUID() }).expect(404);
    });

    it('la devolución completa siempre se reembolsa en efectivo', async () => {
      const { api } = await escenario();
      const res = await devolver(
        api,
        [
          { renglon: 1, cantidad: '2', destino: 'INVENTARIO' },
          { renglon: 2, cantidad: '0.5', destino: 'INVENTARIO' },
        ],
        'Cambio',
        'SALDO_FAVOR',
      ).expect(422);
      expect(res.body.detail).to.match(/se reembolsa en efectivo/);
    });
  });
});
