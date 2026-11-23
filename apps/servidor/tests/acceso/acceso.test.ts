import { expect } from 'chai';
import request from 'supertest';
import {
  adelantar,
  appNueva,
  appDePrueba,
  cliente,
  iniciarSesion,
  PIN_DUENO,
  PIN_EMPLEADO,
  PIN_INICIAL,
  registrosBitacora,
} from '../ayuda';
import sinon from 'sinon';
import { redis } from '../../src/infraestructura/redis';
import { IntentosPin } from '../../src/modulos/acceso/acceso';

describe('Acceso con PIN', () => {
  describe('primer acceso', () => {
    it('el Dueño inicial entra con el PIN temporal y debe cambiarlo', async () => {
      const { sinSesion } = await appNueva();
      const res = await sinSesion.post('/api/v1/auth/pin').send({ pin: PIN_INICIAL }).expect(200);
      expect(res.body.data.usuario).to.include({ rol: 'DUENO', debeCambiarPin: true });
      expect(res.body.data.usuario).to.not.have.property('pinHash');
    });

    it('con el PIN temporal solo puede cambiar su PIN', async () => {
      const { app } = await appNueva();
      const api = cliente(app, await iniciarSesion(app, PIN_INICIAL));
      const res = await api.get('/api/v1/productos').expect(403);
      expect(res.body.detail).to.match(/cambiar su PIN/);
      await api.patch('/api/v1/auth/mi-pin').send({ pin: PIN_DUENO }).expect(200);
      await api.get('/api/v1/productos').expect(200);
    });

    it('después del cambio, el PIN temporal deja de servir', async () => {
      const { app, sinSesion } = await appNueva();
      const api = cliente(app, await iniciarSesion(app, PIN_INICIAL));
      await api.patch('/api/v1/auth/mi-pin').send({ pin: PIN_DUENO }).expect(200);
      await sinSesion.post('/api/v1/auth/pin').send({ pin: PIN_INICIAL }).expect(401);
    });
  });

  describe('inicio de sesión', () => {
    it('con un PIN válido devuelve los tokens, el usuario y los permisos de su rol', async () => {
      const { sinSesion } = await appDePrueba();
      const res = await sinSesion.post('/api/v1/auth/pin').send({ pin: PIN_EMPLEADO }).expect(200);
      const { data } = res.body;
      expect(data.tokenAcceso).to.be.a('string');
      expect(data.tokenRenovacion).to.be.a('string');
      expect(data.usuario).to.include({ nombre: 'Empleado de prueba', rol: 'EMPLEADO' });
      expect(data.permisos).to.include('venta:cobrar');
      expect(data.permisos).to.not.include('producto:precio');
    });

    it('con un PIN inexistente no inicia sesión e indica los intentos restantes', async () => {
      const { sinSesion } = await appDePrueba();
      const res = await sinSesion.post('/api/v1/auth/pin').send({ pin: '9999' }).expect(401);
      expect(res.body.detail).to.match(/PIN incorrecto.*4 intentos/);
    });

    it('al quinto intento fallido consecutivo bloquea el acceso 5 minutos', async () => {
      const { sinSesion } = await appDePrueba();
      for (let i = 0; i < 4; i++) await sinSesion.post('/api/v1/auth/pin').send({ pin: '9999' }).expect(401);
      const bloqueo = await sinSesion.post('/api/v1/auth/pin').send({ pin: '9999' }).expect(423);
      expect(bloqueo.body.reintentarEnSegundos).to.equal(300);
      // El bloqueo es de la caja: ni con el PIN correcto se entra.
      await sinSesion.post('/api/v1/auth/pin').send({ pin: PIN_DUENO }).expect(423);
      adelantar(4);
      const restante = await sinSesion.post('/api/v1/auth/pin').send({ pin: PIN_DUENO }).expect(423);
      expect(restante.body.reintentarEnSegundos).to.equal(60);
      adelantar(1);
      await sinSesion.post('/api/v1/auth/pin').send({ pin: PIN_DUENO }).expect(200);
    });

    it('un acceso correcto reinicia la cuenta de intentos', async () => {
      const { sinSesion } = await appDePrueba();
      for (let i = 0; i < 4; i++) await sinSesion.post('/api/v1/auth/pin').send({ pin: '9999' }).expect(401);
      await sinSesion.post('/api/v1/auth/pin').send({ pin: PIN_DUENO }).expect(200);
      const res = await sinSesion.post('/api/v1/auth/pin').send({ pin: '9999' }).expect(401);
      expect(res.body.detail).to.match(/4 intentos/);
    });

    it('el bloqueo se guarda en Redis por 5 minutos y sigue aunque se reinicie la API', async () => {
      const { sinSesion } = await appDePrueba();
      for (let i = 0; i < 4; i++) await sinSesion.post('/api/v1/auth/pin').send({ pin: '9999' }).expect(401);
      expect(await redis.get('pos_pruebas:pin:intentos')).to.equal('4');
      await sinSesion.post('/api/v1/auth/pin').send({ pin: '9999' }).expect(423);

      expect(await redis.ttl('pos_pruebas:pin:bloqueo')).to.be.within(1, 300);
      expect(await redis.exists('pos_pruebas:pin:intentos')).to.equal(0);
      // Un contador nuevo, como el de una API recién reiniciada, ve el mismo bloqueo.
      expect(await new IntentosPin().segundosDeBloqueo()).to.equal(300);
    });

    it('si Redis falla, el bloqueo sigue funcionando en memoria', async () => {
      const { sinSesion } = await appDePrueba();
      for (const comando of ['get', 'set', 'incr', 'expire', 'del'] as const) {
        sinon.stub(redis, comando).rejects(new Error('sin conexión'));
      }
      try {
        for (let i = 0; i < 4; i++)
          await sinSesion.post('/api/v1/auth/pin').send({ pin: '9999' }).expect(401);
        await sinSesion.post('/api/v1/auth/pin').send({ pin: '9999' }).expect(423);
        await sinSesion.post('/api/v1/auth/pin').send({ pin: PIN_DUENO }).expect(423);
      } finally {
        sinon.restore();
      }
    });

    it('rechaza un PIN que no tiene 4 dígitos', async () => {
      const { sinSesion } = await appDePrueba();
      await sinSesion.post('/api/v1/auth/pin').send({ pin: '12345' }).expect(400);
    });

    it('cada acceso exitoso, fallido y el bloqueo quedan en bitácora, sin el PIN', async () => {
      const { sinSesion } = await appDePrueba();
      for (let i = 0; i < 5; i++) await sinSesion.post('/api/v1/auth/pin').send({ pin: '9876' });
      const { registros } = await registrosBitacora();
      const acciones = registros.map((r) => r.accion);
      expect(acciones).to.include.members(['ACCESO', 'ACCESO_FALLIDO', 'ACCESO_BLOQUEADO']);
      expect(acciones.filter((a) => a === 'ACCESO_FALLIDO')).to.have.length(5);
      // El PIN se busca solo en acción, antes y después: los ids son UUID al azar y a veces traen
      // "1111" o "9876" de pura casualidad, y eso tumbaba la prueba sin que hubiera ningún PIN.
      const datos = JSON.stringify(registros.map((r) => [r.accion, r.antes, r.despues]));
      expect(datos).to.not.include('9876');
      expect(datos).to.not.include(PIN_DUENO);
      expect(JSON.stringify(registros)).to.not.match(/\$2[aby]\$/); // ningún hash de bcrypt
    });
  });

  describe('token de acceso', () => {
    it('sin token, una ruta protegida responde 401', async () => {
      const { sinSesion } = await appDePrueba();
      const res = await sinSesion.get('/api/v1/productos').expect(401);
      expect(res.body.title).to.equal('Sesión requerida');
    });

    it('un token alterado responde 401', async () => {
      const { app, tokenDueno } = await appDePrueba();
      await cliente(app, tokenDueno.slice(0, -2) + 'xx')
        .get('/api/v1/productos')
        .expect(401);
    });

    it('el token de acceso vence a los 15 minutos y se renueva con el token de renovación', async () => {
      const { app, sinSesion } = await appDePrueba();
      const sesion = await sinSesion.post('/api/v1/auth/pin').send({ pin: PIN_DUENO });
      const { tokenAcceso, tokenRenovacion } = sesion.body.data;
      adelantar(16);
      await cliente(app, tokenAcceso).get('/api/v1/productos').expect(401);
      const renovada = await sinSesion.post('/api/v1/auth/renovar').send({ tokenRenovacion }).expect(200);
      await cliente(app, renovada.body.data.tokenAcceso).get('/api/v1/productos').expect(200);
    });

    it('el token de renovación vence al terminar la jornada', async () => {
      const { sinSesion } = await appDePrueba();
      const sesion = await sinSesion.post('/api/v1/auth/pin').send({ pin: PIN_DUENO });
      adelantar(24 * 60);
      await sinSesion
        .post('/api/v1/auth/renovar')
        .send({ tokenRenovacion: sesion.body.data.tokenRenovacion })
        .expect(401);
    });
  });

  describe('salida y bloqueo por inactividad', () => {
    it('tras cerrar sesión, ningún token de esa sesión sirve', async () => {
      const { app, sinSesion } = await appDePrueba();
      const sesion = await sinSesion.post('/api/v1/auth/pin').send({ pin: PIN_DUENO });
      const { tokenAcceso, tokenRenovacion } = sesion.body.data;
      const api = cliente(app, tokenAcceso);
      await api.post('/api/v1/auth/salir').send({}).expect(200);
      await api.get('/api/v1/productos').expect(401);
      await sinSesion.post('/api/v1/auth/renovar').send({ tokenRenovacion }).expect(401);
    });

    it('el bloqueo por inactividad y el desbloqueo quedan en bitácora', async () => {
      const { app } = await appDePrueba();
      const api = cliente(app, await iniciarSesion(app, PIN_DUENO));
      await api.post('/api/v1/auth/salir').send({ motivo: 'INACTIVIDAD' }).expect(200);
      await request(app)
        .post('/api/v1/auth/pin')
        .send({ pin: PIN_EMPLEADO, motivo: 'DESBLOQUEO' })
        .expect(200);
      const { registros } = await registrosBitacora();
      expect(registros.map((r) => r.accion)).to.include.members(['SESION_BLOQUEADA', 'SESION_DESBLOQUEADA']);
    });
  });

  describe('perfil y accesibilidad', () => {
    it('GET /auth/yo devuelve el usuario de la sesión y sus permisos', async () => {
      const { empleado } = await appDePrueba();
      const res = await empleado.get('/api/v1/auth/yo').expect(200);
      expect(res.body.data.usuario.rol).to.equal('EMPLEADO');
      expect(res.body.data.permisos).to.include('caja:abrir');
    });

    it('guarda el modo accesible y el tamaño de letra en el perfil', async () => {
      const { app, empleado } = await appDePrueba();
      await empleado
        .patch('/api/v1/auth/preferencias')
        .send({ modoAccesible: true, tamanoLetra: 250 })
        .expect(200);
      const res = await request(app).post('/api/v1/auth/pin').send({ pin: PIN_EMPLEADO });
      expect(res.body.data.usuario).to.include({ modoAccesible: true, tamanoLetra: 250 });
    });
  });
});
