import { expect } from 'chai';
import { appDePrueba, productoValido } from '../ayuda';

describe('Categorías', () => {
  it('al iniciar existen las 8 categorías básicas', async () => {
    const { api } = await appDePrueba();
    const res = await api.get('/api/v1/categorias').expect(200);
    const nombres = res.body.data.map((c: { nombre: string }) => c.nombre);
    expect(nombres).to.have.members([
      'Abarrotes',
      'Granel',
      'Bebidas',
      'Lácteos y salchichonería',
      'Botanas y dulces',
      'Panadería',
      'Limpieza',
      'Higiene personal',
    ]);
  });

  it('registra una categoría nueva', async () => {
    const { api } = await appDePrueba();
    const res = await api.post('/api/v1/categorias').send({ nombre: 'Mascotas' }).expect(201);
    expect(res.body.data).to.include({ nombre: 'Mascotas' });
    expect(res.body.data.id).to.be.a('string');
  });

  it('rechaza un nombre repetido aunque cambien acentos o mayúsculas', async () => {
    const { api } = await appDePrueba();
    const res = await api.post('/api/v1/categorias').send({ nombre: 'PANADERIA' }).expect(409);
    expect(res.body.detail).to.match(/Panadería/);
  });

  it('rechaza un nombre vacío indicando el campo', async () => {
    const { api } = await appDePrueba();
    const res = await api.post('/api/v1/categorias').send({ nombre: ' ' }).expect(400);
    expect(res.body.errores[0]).to.include({ campo: 'body.nombre' });
  });

  it('elimina una categoría sin productos', async () => {
    const { api } = await appDePrueba();
    const nueva = await api.post('/api/v1/categorias').send({ nombre: 'Mascotas' });
    await api.delete(`/api/v1/categorias/${nueva.body.data.id}`).expect(200);
    const res = await api.get('/api/v1/categorias');
    expect(res.body.data.map((c: { nombre: string }) => c.nombre)).to.not.include('Mascotas');
  });

  it('no elimina una categoría con productos e indica cuántos tiene', async () => {
    const { api } = await appDePrueba();
    const nueva = await api.post('/api/v1/categorias').send({ nombre: 'Mascotas' });
    const categoriaId = nueva.body.data.id;
    await api
      .post('/api/v1/productos')
      .send({ ...productoValido, categoriaId })
      .expect(201);
    await api
      .post('/api/v1/productos')
      .send({ ...productoValido, codigo: 'CROQ-01', categoriaId })
      .expect(201);
    const res = await api.delete(`/api/v1/categorias/${categoriaId}`).expect(409);
    expect(res.body.detail).to.match(/2 productos/);
  });

  it('responde 404 al eliminar una categoría inexistente', async () => {
    const { api } = await appDePrueba();
    await api.delete('/api/v1/categorias/3f1c2b8e-8a4d-4c55-9a77-6c1d2f0e9b10').expect(404);
  });
});
