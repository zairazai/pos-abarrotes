import { expect } from 'chai';
import sinon from 'sinon';
import { BitacoraServicio } from '../../src/modulos/bitacora/bitacora';
import { ConfiguracionServicio } from '../../src/modulos/configuracion/configuracion';
import { appDePrueba, registrosBitacora } from '../ayuda';

const nueva = {
  nombre: 'Abarrotes Don Pepe',
  direccion: 'Av. Obregón 123, Culiacán',
  telefono: '667 123 4567',
  politicaDevolucion: 'Devoluciones el mismo día presentando este ticket.',
  enlaceBot: 'https://t.me/AbarrotesDonPepeBot',
};

describe('Configuración de la tienda', () => {
  afterEach(() => sinon.restore());

  it('al instalar ya hay datos de la tienda, con nombre y política de devolución', async () => {
    const { api } = await appDePrueba();
    const res = await api.get('/api/v1/configuracion').expect(200);
    expect(res.body.data.nombre).to.equal('Tienda de abarrotes');
    expect(res.body.data.politicaDevolucion).to.not.equal('');
    expect(res.body.data).to.include({ direccion: '', telefono: '', enlaceBot: '' });
  });

  it('el Dueño modifica los datos y la consulta devuelve los nuevos', async () => {
    const { api } = await appDePrueba();
    const res = await api.put('/api/v1/configuracion').send(nueva).expect(200);
    expect(res.body.data).to.include(nueva);
    const consulta = await api.get('/api/v1/configuracion').expect(200);
    expect(consulta.body.data).to.include(nueva);
  });

  it('sin el nombre de la tienda no guarda e indica el campo (3a)', async () => {
    const { api } = await appDePrueba();
    const res = await api
      .put('/api/v1/configuracion')
      .send({ ...nueva, nombre: '' })
      .expect(400);
    expect(res.body.errores.map((e: { campo: string }) => e.campo)).to.deep.equal(['body.nombre']);
    const consulta = await api.get('/api/v1/configuracion');
    expect(consulta.body.data.nombre).to.equal('Tienda de abarrotes');
  });

  it('el cambio queda en la bitácora con los datos de antes y después', async () => {
    const { api } = await appDePrueba();
    await api.put('/api/v1/configuracion').send(nueva).expect(200);
    const { registros } = await registrosBitacora({ accion: 'CONFIGURACION_MODIFICADA' });
    expect(registros).to.have.length(1);
    expect(registros[0]!.antes).to.include({ nombre: 'Tienda de abarrotes' });
    expect(registros[0]!.despues).to.include({ nombre: nueva.nombre });
  });

  it('el Empleado no consulta ni modifica la configuración', async () => {
    const { empleado } = await appDePrueba();
    await empleado.get('/api/v1/configuracion').expect(403);
    await empleado.put('/api/v1/configuracion').send(nueva).expect(403);
  });

  it('el ticket usa los datos nuevos (resultado esperado)', async () => {
    const { api } = await appDePrueba();
    await api.put('/api/v1/configuracion').send(nueva).expect(200);
    const tienda = await new ConfiguracionServicio().datosTienda();
    expect(tienda).to.deep.equal({
      nombre: nueva.nombre,
      direccion: nueva.direccion,
      telefono: nueva.telefono,
      politicaDevolucion: nueva.politicaDevolucion,
      enlaceBot: nueva.enlaceBot,
    });
  });

  it('si falla la bitácora, los datos no cambian', async () => {
    const { api } = await appDePrueba();
    sinon.stub(BitacoraServicio.prototype, 'registrar').rejects(new Error('falla simulada'));
    await api.put('/api/v1/configuracion').send(nueva).expect(500);
    sinon.restore();
    // Se revisa con el servicio: sinon.restore() también quita el reloj falso y el token ya no serviría.
    expect((await new ConfiguracionServicio().consultar()).nombre).to.equal('Tienda de abarrotes');
  });
});
