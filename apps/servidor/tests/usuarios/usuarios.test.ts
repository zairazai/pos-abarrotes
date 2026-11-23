import { expect } from 'chai';
import { appDePrueba, PIN_DUENO, PIN_EMPLEADO, registrosBitacora } from '../ayuda';

describe('Usuarios', () => {
  it('el Dueño registra un usuario que después inicia sesión con su PIN', async () => {
    const { api, sinSesion } = await appDePrueba();
    const res = await api
      .post('/api/v1/usuarios')
      .send({ nombre: 'Luis', rol: 'EMPLEADO', pin: '3333', modoAccesible: true })
      .expect(201);
    expect(res.body.data).to.include({ nombre: 'Luis', rol: 'EMPLEADO', modoAccesible: true, activo: true });
    expect(res.body.data).to.not.have.property('pin');
    expect(res.body.data).to.not.have.property('pinHash');
    await sinSesion.post('/api/v1/auth/pin').send({ pin: '3333' }).expect(200);
  });

  it('el modo accesible activa la letra al 200 % por defecto', async () => {
    const { api } = await appDePrueba();
    const res = await api
      .post('/api/v1/usuarios')
      .send({ nombre: 'Luis', rol: 'EMPLEADO', pin: '3333', modoAccesible: true });
    expect(res.body.data.tamanoLetra).to.equal(200);
  });

  it('no acepta un PIN que ya usa otro usuario activo', async () => {
    const { api } = await appDePrueba();
    const res = await api
      .post('/api/v1/usuarios')
      .send({ nombre: 'Luis', rol: 'EMPLEADO', pin: PIN_EMPLEADO })
      .expect(409);
    expect(res.body.detail).to.match(/PIN/);
    expect(res.body.detail).to.not.include(PIN_EMPLEADO);
  });

  it('lista los usuarios sin exponer el hash del PIN', async () => {
    const { api } = await appDePrueba();
    const res = await api.get('/api/v1/usuarios').expect(200);
    expect(res.body.data).to.have.length(2);
    expect(JSON.stringify(res.body)).to.not.match(/pinHash|\$2[aby]\$/);
  });

  describe('restablecer PIN', () => {
    it('el PIN anterior deja de ser válido y el nuevo funciona', async () => {
      const { api, sinSesion, empleadoId } = await appDePrueba();
      await api.patch(`/api/v1/usuarios/${empleadoId}/pin`).send({ pin: '4444' }).expect(200);
      await sinSesion.post('/api/v1/auth/pin').send({ pin: PIN_EMPLEADO }).expect(401);
      await sinSesion.post('/api/v1/auth/pin').send({ pin: '4444' }).expect(200);
    });

    it('el cambio queda en bitácora sin mostrar el PIN', async () => {
      const { api, empleadoId } = await appDePrueba();
      await api.patch(`/api/v1/usuarios/${empleadoId}/pin`).send({ pin: '4444' }).expect(200);
      const { registros } = await registrosBitacora({ accion: 'USUARIO_PIN_RESTABLECIDO' });
      expect(registros).to.have.length(1);
      // Solo acción, antes y después: un UUID al azar podría traer "4444" por casualidad.
      const datos = JSON.stringify(registros.map((r) => [r.accion, r.antes, r.despues]));
      expect(datos).to.not.include('4444');
    });

    it('rechaza un PIN en uso', async () => {
      const { api, empleadoId } = await appDePrueba();
      await api.patch(`/api/v1/usuarios/${empleadoId}/pin`).send({ pin: PIN_DUENO }).expect(409);
    });
  });

  describe('desactivar', () => {
    it('un usuario desactivado no puede iniciar sesión y pierde la sesión abierta', async () => {
      const { api, empleado, sinSesion, empleadoId } = await appDePrueba();
      await api.patch(`/api/v1/usuarios/${empleadoId}/desactivar`).expect(200);
      await sinSesion.post('/api/v1/auth/pin').send({ pin: PIN_EMPLEADO }).expect(401);
      await empleado.get('/api/v1/productos').expect(401);
    });

    it('el Dueño no puede desactivarse a sí mismo', async () => {
      const { api } = await appDePrueba();
      const yo = await api.get('/api/v1/auth/yo');
      const res = await api.patch(`/api/v1/usuarios/${yo.body.data.usuario.id}/desactivar`).expect(422);
      expect(res.body.detail).to.match(/Dueño activo/);
    });

    it('el PIN de un usuario desactivado se puede volver a asignar', async () => {
      const { api, empleadoId } = await appDePrueba();
      await api.patch(`/api/v1/usuarios/${empleadoId}/desactivar`).expect(200);
      await api
        .post('/api/v1/usuarios')
        .send({ nombre: 'Luis', rol: 'EMPLEADO', pin: PIN_EMPLEADO })
        .expect(201);
    });

    it('responde 404 con un usuario inexistente', async () => {
      const { api } = await appDePrueba();
      await api.patch('/api/v1/usuarios/3f1c2b8e-8a4d-4c55-9a77-6c1d2f0e9b10/desactivar').expect(404);
    });
  });
});
