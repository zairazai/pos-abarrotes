import { expect } from 'chai';
import sinon from 'sinon';
import { randomUUID } from 'node:crypto';
import { Decimal } from '@pos/compartido';
import { fuenteDatos } from '../../src/infraestructura/base-datos/fuente';
import { BitacoraServicio } from '../../src/modulos/bitacora/bitacora';
import { LoteEntidad } from '../../src/modulos/inventario/inventario.tablas';
import { VentaEntidad } from '../../src/modulos/ventas/ventas.tablas';
import { appDePrueba, registrosBitacora, type Api } from '../ayuda';

/** Lo que se cobra en casi todas las pruebas: frijol 38.50 + 0.33 kg de queso a 160 (52.80) = 91.30. */
interface Escenario {
  api: Api;
  empleado: Api;
  duenoId: string;
  empleadoId: string;
  frijol: string;
  queso: string;
  loteFrijol: string;
}

async function escenario(): Promise<Escenario> {
  const { api, empleado, empleadoId } = await appDePrueba();
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
  return { api, empleado, duenoId: dueno.id, empleadoId, frijol, queso, loteFrijol };
}

function venta(e: Escenario, pagos: object[], extra: object = {}) {
  return {
    iniciadaPor: e.duenoId,
    renglones: [
      { productoId: e.frijol, cantidad: '1' },
      { productoId: e.queso, cantidad: '0.33' },
    ],
    pagos,
    ...extra,
  };
}

const efectivo = (monto: string) => ({ metodo: 'EFECTIVO', monto });

function cobrar(api: Api, cuerpo: object, clave: string = randomUUID()) {
  return api.post('/api/v1/ventas').set('Idempotency-Key', clave).send(cuerpo);
}

const ventas = () => fuenteDatos.getRepository(VentaEntidad);

async function existenciaLote(id: string): Promise<string> {
  return (await fuenteDatos.getRepository(LoteEntidad).findOneByOrFail({ id })).existencia.toFixed(2);
}

describe('Ventas: cobro y ticket', () => {
  afterEach(() => sinon.restore());

  describe('cobro', () => {
    it('cobra en efectivo con redondeo a 0.50 y cambio, con los precios del catálogo', async () => {
      const e = await escenario();
      const res = await cobrar(e.api, venta(e, [efectivo('100')])).expect(201);
      expect(res.body.message).to.equal('Venta cobrada con folio 1');
      expect(res.body.data).to.include({
        folio: 1,
        estado: 'COBRADA',
        subtotal: '91.30',
        total: '91.30',
        redondeo: '0.20',
        totalCobrado: '91.50',
        cambio: '8.50',
      });
      expect(res.body.data.renglones.map((r: { importe: string }) => r.importe)).to.deep.equal([
        '38.50',
        '52.80',
      ]);
      expect(res.body.data).to.include({ iniciadaPor: e.duenoId });
    });

    it('acepta pago mixto: solo la parte en efectivo se redondea', async () => {
      const e = await escenario();
      const res = await cobrar(
        e.api,
        venta(e, [{ metodo: 'TARJETA', monto: '50.00', referencia: 'AUT-123' }, efectivo('50')]),
      ).expect(201);
      expect(res.body.data).to.include({ redondeo: '0.20', totalCobrado: '91.50', cambio: '8.50' });
      expect(res.body.data.pagos).to.deep.equal([
        { metodo: 'TARJETA', monto: '50.00', referencia: 'AUT-123' },
        { metodo: 'EFECTIVO', monto: '50.00', referencia: null },
      ]);
    });

    it('el efectivo neto de cada venta entra al esperado de la caja, solo visible para el Dueño', async () => {
      const e = await escenario();
      await cobrar(e.api, venta(e, [efectivo('100')])).expect(201);
      await cobrar(
        e.api,
        venta(e, [{ metodo: 'TRANSFERENCIA', monto: '91.30', referencia: 'SPEI-9' }]),
      ).expect(201);
      const caja = (await e.api.get('/api/v1/caja/actual').expect(200)).body.data.caja;
      expect(caja).to.include({ esperado: '591.50', ventasEfectivo: '91.50' });
      expect(caja.movimientos).to.deep.equal([]);
      const ciega = (await e.empleado.get('/api/v1/caja/actual').expect(200)).body.data.caja;
      expect(ciega).to.not.have.any.keys('esperado', 'ventasEfectivo');
    });

    it('si los pagos no cubren el total no guarda nada e indica el faltante', async () => {
      const e = await escenario();
      const res = await cobrar(e.api, venta(e, [efectivo('90')])).expect(422);
      expect(res.body.detail).to.match(/faltan \$1\.50/);
      expect(res.body.faltante).to.equal('1.50');
      expect(await ventas().count()).to.equal(0);
      expect(await existenciaLote(e.loteFrijol)).to.equal('10.00');
    });

    it('exige la referencia de tarjeta y transferencia', async () => {
      const e = await escenario();
      const res = await cobrar(e.api, venta(e, [{ metodo: 'TARJETA', monto: '91.30' }])).expect(400);
      expect(res.body.errores[0].campo).to.equal('body.pagos.0.referencia');
    });

    it('no acepta precios enviados por la pantalla', async () => {
      const e = await escenario();
      const cuerpo = venta(e, [efectivo('100')], {
        renglones: [{ productoId: e.frijol, cantidad: '1', precio: '1.00' }],
      });
      await cobrar(e.api, cuerpo).expect(400);
    });

    it('usa el precio vigente aunque haya cambiado después de escanear', async () => {
      const e = await escenario();
      await e.api.patch(`/api/v1/productos/${e.frijol}/precio`).send({ precio: '40.00' }).expect(200);
      const res = await cobrar(e.api, venta(e, [efectivo('100')])).expect(201);
      expect(res.body.data.total).to.equal('92.80');
    });

    it('no cobra un producto desactivado', async () => {
      const e = await escenario();
      await e.api.delete(`/api/v1/productos/${e.queso}`).expect(200);
      const res = await cobrar(e.api, venta(e, [efectivo('100')])).expect(422);
      expect(res.body.detail).to.match(/Queso fresco está desactivado/);
    });

    it('las piezas deben ser enteras', async () => {
      const e = await escenario();
      const cuerpo = venta(e, [efectivo('100')], { renglones: [{ productoId: e.frijol, cantidad: '1.5' }] });
      const res = await cobrar(e.api, cuerpo).expect(422);
      expect(res.body.detail).to.match(/piezas/);
    });

    it('sin caja abierta no se cobra, ni después de empezar el arqueo', async () => {
      const e = await escenario();
      await e.api
        .post('/api/v1/caja/arqueo')
        .send({ conteo: { B100: 5 } })
        .expect(201);
      const res = await cobrar(e.api, venta(e, [efectivo('100')])).expect(409);
      expect(res.body.detail).to.match(/arqueo/);
      await e.api.post('/api/v1/caja/cierre').send({}).expect(200);
      await cobrar(e.api, venta(e, [efectivo('100')])).expect(422);
    });

    it('guarda quién inició la venta y quién la cobró', async () => {
      const e = await escenario();
      const res = await cobrar(e.api, venta(e, [efectivo('100')], { iniciadaPor: e.empleadoId })).expect(201);
      expect(res.body.data.iniciadaPor).to.equal(e.empleadoId);
      expect(res.body.data.cobradaPor).to.equal(e.duenoId);
      await cobrar(e.api, venta(e, [efectivo('100')], { iniciadaPor: randomUUID() })).expect(422);
    });

    it('los folios son consecutivos', async () => {
      const e = await escenario();
      for (const folio of [1, 2, 3]) {
        const res = await cobrar(e.empleado, venta(e, [efectivo('100')])).expect(201);
        expect(res.body.data.folio).to.equal(folio);
      }
    });

    it('queda en la bitácora', async () => {
      const e = await escenario();
      await cobrar(e.api, venta(e, [efectivo('100')])).expect(201);
      const { registros } = await registrosBitacora({ accion: 'VENTA_COBRADA' });
      expect(registros).to.have.length(1);
      expect(registros[0]!.despues).to.include({ folio: 1, total: '91.30', totalCobrado: '91.50' });
    });
  });

  describe('inventario al cobrar', () => {
    it('descuenta del lote y guarda de qué lote salió cada renglón', async () => {
      const e = await escenario();
      const cuerpo = venta(e, [efectivo('100')], { renglones: [{ productoId: e.frijol, cantidad: '2' }] });
      await cobrar(e.api, cuerpo).expect(201);
      expect(await existenciaLote(e.loteFrijol)).to.equal('8.00');
      const filas = await fuenteDatos.query('SELECT lote_id, cantidad FROM venta_detalle_lote');
      expect(filas).to.deep.equal([{ lote_id: e.loteFrijol, cantidad: '2.00' }]);
    });

    it('vende sin existencias y avisa', async () => {
      const e = await escenario();
      const res = await cobrar(e.api, venta(e, [efectivo('100')])).expect(201);
      expect(res.body.data.avisos).to.deep.equal([
        { productoId: e.queso, nombre: 'Queso fresco', faltante: '0.33' },
      ]);
      const existencia = await e.api.get('/api/v1/productos/codigo/QUE-1').expect(200);
      expect(existencia.body.data.existencia).to.equal('-0.33');
    });
  });

  describe('descuento manual', () => {
    it('el Dueño cobra con descuento al renglón y a la venta, y queda en la bitácora', async () => {
      const e = await escenario();
      const cuerpo = venta(e, [efectivo('120')], {
        renglones: [
          { productoId: e.frijol, cantidad: '2', descuento: { tipo: 'MONTO', valor: '7.00' } },
          { productoId: e.queso, cantidad: '0.33' },
        ],
        descuento: { tipo: 'PORCENTAJE', valor: '10' },
      });
      const res = await cobrar(e.api, cuerpo).expect(201);
      // 77.00 - 7.00 + 52.80 = 122.80; 10 % = 12.28; total 110.52.
      expect(res.body.data).to.include({ subtotal: '129.80', descuentoManual: '19.28', total: '110.52' });
      expect(res.body.data.renglones[0].descuentoManual).to.equal('7.00');
      const { registros } = await registrosBitacora({ accion: 'VENTA_DESCUENTO' });
      expect(registros[0]!.despues).to.include({ descuentoManual: '19.28' });
    });

    it('el Empleado no cobra una venta con descuento (403)', async () => {
      const e = await escenario();
      const cuerpo = venta(e, [efectivo('100')], { descuento: { tipo: 'MONTO', valor: '1.00' } });
      const res = await cobrar(e.empleado, cuerpo).expect(403);
      expect(res.body.detail).to.match(/Solo el Dueño aplica descuentos/);
    });

    it('rechaza un descuento mayor que el importe (3a)', async () => {
      const e = await escenario();
      const cuerpo = venta(e, [efectivo('100')], {
        renglones: [{ productoId: e.frijol, cantidad: '1', descuento: { tipo: 'MONTO', valor: '40.00' } }],
      });
      const res = await cobrar(e.api, cuerpo).expect(422);
      expect(res.body.detail).to.match(/excede/);
    });

    it('un descuento del 100 % deja la venta en cero y se cobra sin pagos', async () => {
      const e = await escenario();
      const cuerpo = venta(e, [], { descuento: { tipo: 'PORCENTAJE', valor: '100' } });
      const res = await cobrar(e.api, cuerpo).expect(201);
      expect(res.body.data).to.include({ total: '0.00', totalCobrado: '0.00', cambio: '0.00' });
    });
  });

  describe('cobro sin duplicados', () => {
    it('la misma Idempotency-Key devuelve la venta ya cobrada y no descuenta otra vez', async () => {
      const e = await escenario();
      const clave = randomUUID();
      const primera = await cobrar(e.api, venta(e, [efectivo('100')]), clave).expect(201);
      const repetida = await cobrar(e.api, venta(e, [efectivo('100')]), clave).expect(200);
      expect(repetida.body.data.folio).to.equal(primera.body.data.folio);
      expect(repetida.body.message).to.match(/ya estaba cobrada/);
      expect(await ventas().count()).to.equal(1);
      expect(await existenciaLote(e.loteFrijol)).to.equal('9.00');
    });

    it('dos peticiones simultáneas con la misma clave crean una sola venta', async () => {
      const e = await escenario();
      const clave = randomUUID();
      const respuestas = await Promise.all([
        cobrar(e.api, venta(e, [efectivo('100')]), clave),
        cobrar(e.api, venta(e, [efectivo('100')]), clave),
      ]);
      expect(respuestas.map((r) => r.status).sort()).to.deep.equal([200, 201]);
      expect(await ventas().count()).to.equal(1);
      expect(await existenciaLote(e.loteFrijol)).to.equal('9.00');
    });

    it('exige la cabecera Idempotency-Key', async () => {
      const e = await escenario();
      const res = await e.api
        .post('/api/v1/ventas')
        .send(venta(e, [efectivo('100')]))
        .expect(400);
      expect(res.body.errores[0].campo).to.equal('headers.idempotency-key');
    });
  });

  describe('venta cancelada sin cobrar', () => {
    it('queda registrada sin folio, con quién la canceló, sin tocar inventario ni caja', async () => {
      const e = await escenario();
      const res = await e.empleado
        .post('/api/v1/ventas/canceladas')
        .send({ iniciadaPor: e.empleadoId, renglones: [{ productoId: e.frijol, cantidad: '3' }] })
        .expect(201);
      expect(res.body.data).to.include({
        estado: 'CANCELADA',
        folio: null,
        motivoCancelacion: 'EN_CURSO',
        canceladaPor: e.empleadoId,
        total: '115.50',
      });
      expect(await existenciaLote(e.loteFrijol)).to.equal('10.00');
      const caja = (await e.api.get('/api/v1/caja/actual').expect(200)).body.data.caja;
      expect(caja.esperado).to.equal('500.00');
      expect((await registrosBitacora({ accion: 'VENTA_CANCELADA' })).registros).to.have.length(1);
    });

    it('no ocupa folio: la siguiente venta cobrada sigue en el 1', async () => {
      const e = await escenario();
      await e.api
        .post('/api/v1/ventas/canceladas')
        .send({ iniciadaPor: e.duenoId, renglones: [{ productoId: e.frijol, cantidad: '1' }] })
        .expect(201);
      const res = await cobrar(e.api, venta(e, [efectivo('100')])).expect(201);
      expect(res.body.data.folio).to.equal(1);
    });
  });

  describe('ticket y reimpresión', () => {
    it('la primera vez entrega el original en PDF y después copias registradas en la bitácora', async () => {
      const e = await escenario();
      await cobrar(e.api, venta(e, [efectivo('100')])).expect(201);

      const original = await e.api.get('/api/v1/ventas/1/ticket.pdf').expect(200);
      expect(original.headers['content-type']).to.match(/application\/pdf/);
      expect(original.headers['x-ticket-copia']).to.equal('false');
      expect(original.headers['content-disposition']).to.equal('inline; filename="ticket-1.pdf"');
      expect(Buffer.from(original.body).subarray(0, 5).toString()).to.equal('%PDF-');
      expect((await registrosBitacora({ accion: 'TICKET_REIMPRESO' })).registros).to.have.length(0);

      const copia = await e.empleado.get('/api/v1/ventas/1/ticket.pdf').expect(200);
      expect(copia.headers['x-ticket-copia']).to.equal('true');
      expect(copia.headers['content-disposition']).to.equal('inline; filename="ticket-1-copia.pdf"');
      expect((await registrosBitacora({ accion: 'TICKET_REIMPRESO' })).registros).to.have.length(1);
    });

    it('reimprime el último ticket emitido', async () => {
      const e = await escenario();
      await e.api.get('/api/v1/ventas/ultimo/ticket.pdf').expect(404);
      await cobrar(e.api, venta(e, [efectivo('100')])).expect(201);
      await cobrar(e.api, venta(e, [efectivo('100')])).expect(201);
      const res = await e.api.get('/api/v1/ventas/ultimo/ticket.pdf').expect(200);
      expect(res.headers['content-disposition']).to.equal('inline; filename="ticket-2.pdf"');
    });

    it('avisa si el folio no existe (2a)', async () => {
      const e = await escenario();
      const res = await e.api.get('/api/v1/ventas/99/ticket.pdf').expect(404);
      expect(res.body.detail).to.match(/folio 99/);
      await e.api.get('/api/v1/ventas/abc/ticket.pdf').expect(400);
    });

    it('consulta la venta por folio', async () => {
      const e = await escenario();
      await cobrar(e.api, venta(e, [efectivo('100')])).expect(201);
      const res = await e.empleado.get('/api/v1/ventas/1').expect(200);
      expect(res.body.data).to.include({ folio: 1, total: '91.30' });
      expect(res.body.data.renglones).to.have.length(2);
    });
  });

  describe('operaciones completas o nada', () => {
    it('si falla la bitácora al final del cobro, no queda venta, ni descuento de lotes, ni efectivo', async () => {
      const e = await escenario();
      sinon.stub(BitacoraServicio.prototype, 'registrar').rejects(new Error('falla simulada'));
      await cobrar(e.api, venta(e, [efectivo('100')])).expect(500);
      sinon.restore();
      expect(await ventas().count()).to.equal(0);
      expect(await existenciaLote(e.loteFrijol)).to.equal('10.00');
      expect(await fuenteDatos.getRepository(LoteEntidad).countBy({ productoId: e.queso })).to.equal(0);
      const [{ total }] = await fuenteDatos.query(`SELECT count(*)::int AS total FROM movimiento_efectivo`);
      expect(total).to.equal(0);
    });
  });

  describe('ventas abiertas al cerrar la caja', () => {
    it('se cancelan a nombre del sistema en la misma operación del cierre y conservan quién las inició', async () => {
      const e = await escenario();
      await e.api
        .post('/api/v1/caja/arqueo')
        .send({ conteo: { B100: 5 } })
        .expect(201);
      await e.api
        .post('/api/v1/caja/cierre')
        .send({
          ventasAbiertas: [
            { iniciadaPor: e.empleadoId, renglones: [{ productoId: e.frijol, cantidad: '2' }] },
            { iniciadaPor: e.duenoId, renglones: [{ productoId: e.queso, cantidad: '0.50' }] },
          ],
        })
        .expect(200);

      const canceladas = await ventas().find({ order: { total: 'ASC' } });
      expect(
        canceladas.map((v) => [v.estado, v.motivoCancelacion, v.canceladaPor, v.iniciadaPor]),
      ).to.deep.equal([
        ['CANCELADA', 'CIERRE', null, e.empleadoId],
        ['CANCELADA', 'CIERRE', null, e.duenoId],
      ]);
      expect(await existenciaLote(e.loteFrijol)).to.equal('10.00');
      const { registros } = await registrosBitacora({ accion: 'VENTA_CANCELADA' });
      expect(registros.map((r) => r.usuarioId)).to.deep.equal([null, null]);
      const cierre = await registrosBitacora({ accion: 'CAJA_CERRADA' });
      expect(cierre.registros[0]!.despues).to.include({ ventasCanceladas: 2 });
    });

    it('si una venta abierta no se puede registrar, el cierre no se aplica', async () => {
      const e = await escenario();
      await e.api
        .post('/api/v1/caja/arqueo')
        .send({ conteo: { B100: 5 } })
        .expect(201);
      const res = await e.api
        .post('/api/v1/caja/cierre')
        .send({
          ventasAbiertas: [
            { iniciadaPor: e.duenoId, renglones: [{ productoId: e.frijol, cantidad: '1' }] },
            { iniciadaPor: e.duenoId, renglones: [{ productoId: randomUUID(), cantidad: '1' }] },
          ],
        })
        .expect(422);
      expect(res.body.detail).to.match(/no existe/);
      expect(await ventas().count()).to.equal(0);
      const caja = (await e.api.get('/api/v1/caja/actual').expect(200)).body.data.caja;
      expect(caja.estado).to.equal('ABIERTA');
    });

    it('sin ventas abiertas el cierre funciona igual que antes', async () => {
      const e = await escenario();
      await e.api
        .post('/api/v1/caja/arqueo')
        .send({ conteo: { B100: 5 } })
        .expect(201);
      await e.api.post('/api/v1/caja/cierre').send({}).expect(200);
      expect(await ventas().count()).to.equal(0);
    });
  });
});
