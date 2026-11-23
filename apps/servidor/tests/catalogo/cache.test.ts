import { expect } from 'chai';
import sinon from 'sinon';
import { fuenteDatos } from '../../src/infraestructura/base-datos/fuente';
import { redis } from '../../src/infraestructura/redis';
import { CatalogoServicio } from '../../src/modulos/catalogo/catalogo';
import { appDePrueba, productoValido, type Api } from '../ayuda';

const base = 'pos_pruebas';

async function registrar(api: Api, codigo = productoValido.codigo) {
  const [categoria] = await fuenteDatos.query(`SELECT id FROM categoria WHERE nombre = 'Abarrotes'`);
  const res = await api
    .post('/api/v1/productos')
    .send({ ...productoValido, codigo, categoriaId: categoria.id })
    .expect(201);
  return res.body.data as { id: string; codigo: string; categoriaId: string };
}

// Cambia el precio directo en PostgreSQL, sin pasar por la API, para saber de dónde sale la respuesta.
const precioEnBase = (id: string, precio: string) =>
  fuenteDatos.query('UPDATE producto SET precio = $1 WHERE id = $2', [precio, id]);

describe('Caché del catálogo en Redis (cache-aside, cap. 7)', () => {
  it('la segunda consulta por código sale de Redis y dura 5 minutos', async () => {
    const { api } = await appDePrueba();
    const p = await registrar(api);
    await api.get(`/api/v1/productos/codigo/${p.codigo}`).expect(200);

    const ttl = await redis.ttl(`${base}:producto:codigo:${p.codigo}`);
    expect(ttl).to.be.within(1, 300);
    await precioEnBase(p.id, '99.00');
    const res = await api.get(`/api/v1/productos/codigo/${p.codigo}`).expect(200);
    expect(res.body.data.precio).to.equal('38.50');
  });

  it('el código se busca sin importar mayúsculas y la existencia no se guarda en la caché', async () => {
    const { api } = await appDePrueba();
    const p = await registrar(api, 'ab-100');
    await api.get('/api/v1/productos/codigo/AB-100').expect(200);
    const guardado = JSON.parse((await redis.get(`${base}:producto:codigo:AB-100`))!);
    expect(guardado).to.not.have.property('existencia');
    const res = await api.get('/api/v1/productos/codigo/ab-100').expect(200);
    expect(res.body.data).to.include({ id: p.id, existencia: '0.00' });
  });

  it('al cambiar el precio se borra de la caché y no sale el precio viejo', async () => {
    const { api } = await appDePrueba();
    const p = await registrar(api);
    await api.get(`/api/v1/productos/${p.id}`).expect(200);
    await api.get(`/api/v1/productos/codigo/${p.codigo}`).expect(200);

    await api.patch(`/api/v1/productos/${p.id}/precio`).send({ precio: '40.00' }).expect(200);
    expect((await api.get(`/api/v1/productos/${p.id}`)).body.data.precio).to.equal('40.00');
    expect((await api.get(`/api/v1/productos/codigo/${p.codigo}`)).body.data.precio).to.equal('40.00');
  });

  it('al modificar el código, el código anterior ya no encuentra el producto', async () => {
    const { api } = await appDePrueba();
    const p = await registrar(api);
    await api.get(`/api/v1/productos/codigo/${p.codigo}`).expect(200);
    const { precio: _p, ...datos } = { ...productoValido, categoriaId: p.categoriaId };
    await api
      .put(`/api/v1/productos/${p.id}`)
      .send({ ...datos, codigo: 'NUEVO-1' })
      .expect(200);
    await api.get(`/api/v1/productos/codigo/${p.codigo}`).expect(404);
    await api.get('/api/v1/productos/codigo/NUEVO-1').expect(200);
  });

  it('al desactivar, el producto ya no se encuentra ni por código ni por id', async () => {
    const { api } = await appDePrueba();
    const p = await registrar(api);
    await api.get(`/api/v1/productos/${p.id}`).expect(200);
    await api.get(`/api/v1/productos/codigo/${p.codigo}`).expect(200);
    await api.delete(`/api/v1/productos/${p.id}`).expect(200);
    await api.get(`/api/v1/productos/${p.id}`).expect(404);
    await api.get(`/api/v1/productos/codigo/${p.codigo}`).expect(404);
  });

  it('una entrada de mercancía cambia el costo y se borra de la caché', async () => {
    const { api } = await appDePrueba();
    const p = await registrar(api);
    await api.get(`/api/v1/productos/${p.id}`).expect(200);
    const proveedor = await api.post('/api/v1/proveedores').send({ nombre: 'Abarrotera' }).expect(201);
    await api
      .post('/api/v1/inventario/entradas')
      .send({
        proveedorId: proveedor.body.data.id,
        folioNota: 'C-1',
        renglones: [{ productoId: p.id, cantidad: '2', costoUnitario: '33.00', caducidad: null }],
      })
      .expect(201);
    expect((await api.get(`/api/v1/productos/${p.id}`)).body.data.costo).to.equal('33.00');
  });

  it('si Redis falla, el catálogo responde igual desde PostgreSQL', async () => {
    const { api } = await appDePrueba();
    const p = await registrar(api);
    sinon.stub(redis, 'get').rejects(new Error('sin conexión'));
    sinon.stub(redis, 'set').rejects(new Error('sin conexión'));
    try {
      const res = await api.get(`/api/v1/productos/codigo/${p.codigo}`).expect(200);
      expect(res.body.data.precio).to.equal('38.50');
    } finally {
      sinon.restore();
    }
  });

  it('al arrancar se precargan los productos activos (warm-up)', async () => {
    const { api } = await appDePrueba();
    const activo = await registrar(api, 'ACT-1');
    const inactivo = await registrar(api, 'INA-1');
    await api.delete(`/api/v1/productos/${inactivo.id}`).expect(200);
    await redis.flushDb();

    expect(await new CatalogoServicio().precargarCache()).to.equal(1);
    expect(await redis.exists(`${base}:producto:id:${activo.id}`)).to.equal(1);
    expect(await redis.exists(`${base}:producto:codigo:ACT-1`)).to.equal(1);
    expect(await redis.exists(`${base}:producto:id:${inactivo.id}`)).to.equal(0);
  });
});
