import { expect } from 'chai';
import { randomUUID } from 'node:crypto';
import { fuenteDatos } from '../../src/infraestructura/base-datos/fuente';
import { PromocionesServicio } from '../../src/modulos/promociones/promociones';
import { iniciarProgramadas } from '../../src/trabajos/programadas';
import { appDePrueba, productoValido, registrosBitacora, type Api } from '../ayuda';

/** Caja abierta y frijol a 38.50 sin lotes; hoy es 2026-10-17. */
async function escenario() {
  const { api, empleado } = await appDePrueba();
  await api
    .post('/api/v1/caja/apertura')
    .send({ fondoInicial: { B100: 5 } })
    .expect(201);
  const [categoria] = await fuenteDatos.query(`SELECT id FROM categoria WHERE nombre = 'Abarrotes'`);
  const [dueno] = await fuenteDatos.query(`SELECT id FROM usuario WHERE rol = 'DUENO'`);
  const frijol = await api
    .post('/api/v1/productos')
    .send({ ...productoValido, categoriaId: categoria.id })
    .expect(201);
  return { api, empleado, frijol: frijol.body.data.id as string, duenoId: dueno.id as string };
}

const dosPorUno = { tipo: 'NXM', lleva: 2, paga: 1 };

const cobrar = (api: Api, duenoId: string, renglon: object, extra: object = {}) =>
  api
    .post('/api/v1/ventas')
    .set('Idempotency-Key', randomUUID())
    .send({
      iniciadaPor: duenoId,
      renglones: [renglon],
      pagos: [{ metodo: 'EFECTIVO', monto: '500' }],
      ...extra,
    });

/** Promoción directo en la base, con fechas que la API no aceptaría. */
const insertar = (productoId: string, usuarioId: string, inicio: string, fin: string, estado: string) =>
  fuenteDatos.query(
    `INSERT INTO promocion (id, producto_id, tipo, precio, inicio, fin, estado, creada_por, creada_en)
     VALUES (gen_random_uuid(), $1, 'PRECIO_ESPECIAL', 10, $2, $3, $4, $5, now())`,
    [productoId, inicio, fin, estado, usuarioId],
  );

describe('Promociones al cobrar', () => {
  it('se aplica sola al vender y queda el ahorro en la venta y en el renglón', async () => {
    const { api, empleado, frijol, duenoId } = await escenario();
    const promo = await api
      .post('/api/v1/promociones')
      .send({ productoId: frijol, ...dosPorUno, inicio: '2026-10-17', fin: '2026-10-20' })
      .expect(201);

    const res = await cobrar(empleado, duenoId, { productoId: frijol, cantidad: '3' }).expect(201);
    // 3 x 38.50 = 115.50, menos una pieza gratis.
    expect(res.body.data).to.include({ subtotal: '115.50', ahorroPromociones: '38.50', total: '77.00' });
    expect(res.body.data.renglones[0]).to.include({ descuentoPromocion: '38.50', importe: '115.50' });

    const [detalle] = await fuenteDatos.query(`SELECT promocion_id FROM venta_detalle`);
    expect(detalle.promocion_id).to.equal(promo.body.data.id);
    await api.get(`/api/v1/ventas/${res.body.data.folio}/ticket.pdf`).expect(200);
  });

  it('una promoción que se registra hoy aplica de inmediato (se borra la caché)', async () => {
    const { api, frijol, duenoId } = await escenario();
    const antes = await cobrar(api, duenoId, { productoId: frijol, cantidad: '2' }).expect(201);
    expect(antes.body.data.total).to.equal('77.00');

    await api
      .post('/api/v1/promociones')
      .send({ productoId: frijol, ...dosPorUno, inicio: '2026-10-17', fin: '2026-10-17' })
      .expect(201);
    const despues = await cobrar(api, duenoId, { productoId: frijol, cantidad: '2' }).expect(201);
    expect(despues.body.data.total).to.equal('38.50');
  });

  it('no se aplica antes de su inicio ni después de su fin', async () => {
    const { api, frijol, duenoId } = await escenario();
    await insertar(frijol, duenoId, '2026-10-10', '2026-10-16', 'VENCIDA');
    await insertar(frijol, duenoId, '2026-10-18', '2026-10-20', 'PROGRAMADA');
    const res = await cobrar(api, duenoId, { productoId: frijol, cantidad: '1' }).expect(201);
    expect(res.body.data).to.include({ ahorroPromociones: '0.00', total: '38.50' });
  });

  it('aplica por sus fechas aunque el worker no la haya activado', async () => {
    const { api, frijol, duenoId } = await escenario();
    await insertar(frijol, duenoId, '2026-10-17', '2026-10-20', 'PROGRAMADA');
    const res = await cobrar(api, duenoId, { productoId: frijol, cantidad: '1' }).expect(201);
    expect(res.body.data).to.include({ ahorroPromociones: '28.50', total: '10.00' });
  });

  it('el descuento manual se suma sobre lo que deja la promoción', async () => {
    const { api, frijol, duenoId } = await escenario();
    await api
      .post('/api/v1/promociones')
      .send({
        productoId: frijol,
        tipo: 'PRECIO_ESPECIAL',
        precio: '30.00',
        inicio: '2026-10-17',
        fin: '2026-10-20',
      })
      .expect(201);
    const res = await cobrar(api, duenoId, {
      productoId: frijol,
      cantidad: '2',
      descuento: { tipo: 'PORCENTAJE', valor: '10' },
    }).expect(201);
    expect(res.body.data).to.include({ ahorroPromociones: '17.00', descuentoManual: '6.00', total: '54.00' });
  });

  it('en una devolución cuenta lo que se pagó con la promoción', async () => {
    const { api, frijol, duenoId } = await escenario();
    await api
      .post('/api/v1/promociones')
      .send({ productoId: frijol, ...dosPorUno, inicio: '2026-10-17', fin: '2026-10-20' })
      .expect(201);
    await cobrar(api, duenoId, { productoId: frijol, cantidad: '2' }).expect(201);
    const venta = await api.get('/api/v1/devoluciones/folio/1').expect(200);
    expect(venta.body.data.renglones[0].neto).to.equal('38.50');
    const res = await api
      .post('/api/v1/devoluciones')
      .send({
        folio: 1,
        motivo: 'Ya no lo quiso',
        renglones: [{ renglon: 1, cantidad: '1', destino: 'INVENTARIO' }],
      })
      .expect(201);
    // Pagó 38.50 por las dos: cada una 19.25, y se redondea a 50 centavos.
    expect(res.body.data.reembolso).to.equal('19.50');
  });

  describe('activar y vencer', () => {
    it('concilia el estado con las fechas, lo registra y no repite', async () => {
      const { frijol, duenoId } = await escenario();
      await insertar(frijol, duenoId, '2026-10-17', '2026-10-20', 'PROGRAMADA');
      await insertar(frijol, duenoId, '2026-10-10', '2026-10-16', 'ACTIVA');
      await insertar(frijol, duenoId, '2026-09-01', '2026-09-05', 'PROGRAMADA');
      const servicio = new PromocionesServicio();

      expect(await servicio.conciliar()).to.equal(3);
      const estados = await fuenteDatos.query(`SELECT estado FROM promocion ORDER BY inicio DESC`);
      expect(estados.map((e: { estado: string }) => e.estado)).to.deep.equal([
        'ACTIVA',
        'VENCIDA',
        'VENCIDA',
      ]);
      expect((await registrosBitacora({ accion: 'PROMOCION_ACTIVADA' })).registros).to.have.length(1);
      expect((await registrosBitacora({ accion: 'PROMOCION_VENCIDA' })).registros).to.have.length(2);

      expect(await servicio.conciliar()).to.equal(0);
    });

    it('el worker la programa a diario y concilia al arrancar', async () => {
      const { frijol, duenoId } = await escenario();
      await insertar(frijol, duenoId, '2026-10-17', '2026-10-20', 'PROGRAMADA');
      const { cola, worker } = await iniciarProgramadas();
      try {
        await new Promise<void>((listo) =>
          worker.on('completed', (job) => {
            if (job.name === 'vigencia-promociones') listo();
          }),
        );
        const [{ estado }] = await fuenteDatos.query(`SELECT estado FROM promocion`);
        expect(estado).to.equal('ACTIVA');
        const programada = await cola.getJobScheduler('vigencia-promociones');
        expect(programada).to.deep.include({ pattern: '0 0 * * *', tz: 'America/Mazatlan' });
      } finally {
        await worker.close();
        await cola.close();
      }
    });
  });
});
