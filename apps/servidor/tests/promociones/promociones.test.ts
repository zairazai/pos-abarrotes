import { expect } from 'chai';
import { fuenteDatos } from '../../src/infraestructura/base-datos/fuente';
import { appDePrueba, productoValido, registrosBitacora, type Api } from '../ayuda';

// Hoy es 2026-10-17 (reloj de las pruebas).
async function producto(api: Api, extra: object = {}) {
  const [categoria] = await fuenteDatos.query(`SELECT id FROM categoria WHERE nombre = 'Abarrotes'`);
  const res = await api
    .post('/api/v1/productos')
    .send({ ...productoValido, categoriaId: categoria.id, ...extra })
    .expect(201);
  return res.body.data.id as string;
}

const especial = (productoId: string, inicio: string, fin: string, precio = '35.00') => ({
  productoId,
  tipo: 'PRECIO_ESPECIAL',
  precio,
  inicio,
  fin,
});

describe('Promociones: configuración', () => {
  it('el Dueño registra una promoción y queda en la bitácora', async () => {
    const { api } = await appDePrueba();
    const frijol = await producto(api);
    const res = await api
      .post('/api/v1/promociones')
      .send({ productoId: frijol, tipo: 'NXM', lleva: 3, paga: 2, inicio: '2026-10-17', fin: '2026-10-31' })
      .expect(201);
    expect(res.body.data).to.include({ tipo: 'NXM', lleva: 3, paga: 2, estado: 'ACTIVA', precio: null });
    expect(res.body.data.producto).to.include({ id: frijol, precio: '38.50' });

    const { registros } = await registrosBitacora({ accion: 'PROMOCION_REGISTRADA' });
    expect(registros[0]!.despues).to.include({ tipo: 'NXM', inicio: '2026-10-17', fin: '2026-10-31' });
  });

  it('no deja dos promociones del mismo producto con fechas que se cruzan', async () => {
    const { api } = await appDePrueba();
    const frijol = await producto(api);
    await api
      .post('/api/v1/promociones')
      .send(especial(frijol, '2026-10-20', '2026-10-25'))
      .expect(201);

    const res = await api
      .post('/api/v1/promociones')
      .send(especial(frijol, '2026-10-25', '2026-10-30'))
      .expect(409);
    expect(res.body.detail).to.equal('Frijol negro 1 kg ya tiene una promoción del 2026-10-20 al 2026-10-25');
    // Seguidas sí se permiten.
    await api
      .post('/api/v1/promociones')
      .send(especial(frijol, '2026-10-26', '2026-10-30'))
      .expect(201);
  });

  it('la base de datos también rechaza el traslape', async () => {
    const { api } = await appDePrueba();
    const frijol = await producto(api);
    await api
      .post('/api/v1/promociones')
      .send(especial(frijol, '2026-10-20', '2026-10-25'))
      .expect(201);
    const [{ creada_por }] = await fuenteDatos.query(`SELECT creada_por FROM promocion`);
    let error: Error | null = null;
    try {
      await fuenteDatos.query(
        `INSERT INTO promocion (id, producto_id, tipo, precio, inicio, fin, estado, creada_por, creada_en)
         VALUES (gen_random_uuid(), $1, 'PRECIO_ESPECIAL', 30, '2026-10-22', '2026-10-28', 'PROGRAMADA', $2, now())`,
        [frijol, creada_por],
      );
    } catch (e) {
      error = e as Error;
    }
    expect(error?.message).to.match(/promocion_sin_traslape/);
  });

  it('revisa las condiciones contra el producto y las fechas (422)', async () => {
    const { api } = await appDePrueba();
    const frijol = await producto(api);
    const queso = await producto(api, { codigo: 'QUE-1', nombre: 'Queso', unidad: 'KG', precio: '160.00' });

    const caro = await api
      .post('/api/v1/promociones')
      .send(especial(frijol, '2026-10-17', '2026-10-20', '40'))
      .expect(422);
    expect(caro.body.detail).to.match(/menor al precio normal \(38.50\)/);
    const nxm = await api
      .post('/api/v1/promociones')
      .send({ productoId: queso, tipo: 'NXM', lleva: 2, paga: 1, inicio: '2026-10-17', fin: '2026-10-20' })
      .expect(422);
    expect(nxm.body.detail).to.equal('El NxM solo aplica a productos por pieza');
    const ayer = await api
      .post('/api/v1/promociones')
      .send(especial(frijol, '2026-10-16', '2026-10-20'))
      .expect(422);
    expect(ayer.body.detail).to.equal('La promoción no puede empezar antes de hoy');
  });

  it('solo el Dueño las configura y el producto debe estar activo', async () => {
    const { api, empleado } = await appDePrueba();
    const frijol = await producto(api);
    await empleado
      .post('/api/v1/promociones')
      .send(especial(frijol, '2026-10-17', '2026-10-20'))
      .expect(403);
    await api.delete(`/api/v1/productos/${frijol}`).expect(200);
    await api
      .post('/api/v1/promociones')
      .send(especial(frijol, '2026-10-17', '2026-10-20'))
      .expect(422);
  });

  it('lista las promociones con su estado según las fechas y filtra por estado', async () => {
    const { api, empleado } = await appDePrueba();
    const frijol = await producto(api);
    await api
      .post('/api/v1/promociones')
      .send(especial(frijol, '2026-10-17', '2026-10-18'))
      .expect(201);
    await api
      .post('/api/v1/promociones')
      .send(especial(frijol, '2026-11-01', '2026-11-07'))
      .expect(201);

    const todas = await empleado.get('/api/v1/promociones').expect(200);
    expect(todas.body.data.map((p: { estado: string }) => p.estado)).to.deep.equal(['PROGRAMADA', 'ACTIVA']);
    const activas = await empleado.get('/api/v1/promociones?estado=ACTIVA').expect(200);
    expect(activas.body.data).to.have.length(1);
    expect(activas.body.data[0]).to.include({ inicio: '2026-10-17', fin: '2026-10-18' });
  });
});
