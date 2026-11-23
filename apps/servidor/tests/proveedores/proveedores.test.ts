import { expect } from 'chai';
import { appDePrueba, registrosBitacora } from '../ayuda';

const proveedor = { nombre: 'Abarrotera del Valle', telefono: '667 123 4567' };

describe('Proveedores', () => {
  it('el Dueño registra un proveedor y aparece en la lista', async () => {
    const { api } = await appDePrueba();
    const res = await api.post('/api/v1/proveedores').send(proveedor).expect(201);
    expect(res.body.data).to.include(proveedor);
    expect(res.body.data.id).to.be.a('string');

    const lista = await api.get('/api/v1/proveedores').expect(200);
    expect(lista.body.data.map((p: { nombre: string }) => p.nombre)).to.deep.equal([proveedor.nombre]);
  });

  it('la lista sale en orden alfabético', async () => {
    const { api } = await appDePrueba();
    for (const nombre of ['Sabritas', 'Bimbo', 'Lala']) {
      await api.post('/api/v1/proveedores').send({ nombre }).expect(201);
    }
    const lista = await api.get('/api/v1/proveedores').expect(200);
    expect(lista.body.data.map((p: { nombre: string }) => p.nombre)).to.deep.equal([
      'Bimbo',
      'Lala',
      'Sabritas',
    ]);
  });

  it('no registra dos veces al mismo proveedor aunque cambien acentos o mayúsculas', async () => {
    const { api } = await appDePrueba();
    await api.post('/api/v1/proveedores').send({ nombre: 'Panadería Lupita' }).expect(201);
    const res = await api.post('/api/v1/proveedores').send({ nombre: 'PANADERIA LUPITA' }).expect(409);
    expect(res.body.detail).to.match(/Panadería Lupita/);
  });

  it('sin nombre no registra e indica el campo', async () => {
    const { api } = await appDePrueba();
    const res = await api.post('/api/v1/proveedores').send({ nombre: '', telefono: '667' }).expect(400);
    expect(res.body.errores.map((e: { campo: string }) => e.campo)).to.deep.equal(['body.nombre']);
  });

  it('el Empleado consulta la lista pero no registra proveedores', async () => {
    const { api, empleado } = await appDePrueba();
    await api.post('/api/v1/proveedores').send(proveedor).expect(201);
    const lista = await empleado.get('/api/v1/proveedores').expect(200);
    expect(lista.body.data).to.have.length(1);
    await empleado.post('/api/v1/proveedores').send({ nombre: 'Coca-Cola FEMSA' }).expect(403);
  });

  it('el registro queda en la bitácora', async () => {
    const { api } = await appDePrueba();
    const res = await api.post('/api/v1/proveedores').send(proveedor).expect(201);
    const { registros } = await registrosBitacora({ accion: 'PROVEEDOR_REGISTRADO' });
    expect(registros).to.have.length(1);
    expect(registros[0]).to.include({ entidad: 'proveedor', entidadId: res.body.data.id });
    expect(registros[0]!.despues).to.include(proveedor);
  });
});
