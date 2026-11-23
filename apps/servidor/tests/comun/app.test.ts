import { expect } from 'chai';
import request from 'supertest';
import sinon from 'sinon';
import { appDePrueba, appNueva } from '../ayuda';
import { fuenteDatos } from '../../src/infraestructura/base-datos/fuente';
import { redis } from '../../src/infraestructura/redis';
import { apagarLatido, latir } from '../../src/modulos/salud/salud';
import { iniciarLatido } from '../../src/trabajos/latido';
import { CatalogoServicio } from '../../src/modulos/catalogo/catalogo';

describe('Base de la API', () => {
  afterEach(() => apagarLatido());

  it('GET /api/v1/salud responde con estado, memoria, tiempo activo y sus servicios', async () => {
    const { app } = await appNueva();
    await latir(); // como si el worker estuviera encendido
    const res = await request(app).get('/api/v1/salud').expect(200);
    expect(res.body.success).to.equal(true);
    expect(res.body.data.estado).to.equal('ok');
    expect(res.body.data.servicios).to.deep.equal({ postgres: 'ok', redis: 'ok', worker: 'ok' });
    expect(res.body.data.tiempoActivoSegundos).to.be.a('number');
    expect(res.body.data.memoria.rssMb).to.be.a('number');
  });

  it('GET /api/v1/salud responde 503 si PostgreSQL no contesta', async () => {
    const { app } = await appNueva();
    sinon.stub(fuenteDatos, 'query').rejects(new Error('sin conexión'));
    try {
      const res = await request(app).get('/api/v1/salud').expect(503);
      expect(res.body.data.estado).to.equal('degradado');
      expect(res.body.data.servicios).to.include({ postgres: 'error', redis: 'ok' });
    } finally {
      sinon.restore();
    }
  });

  it('GET /api/v1/salud sigue en 200 si Redis no contesta, porque se trabaja con PostgreSQL', async () => {
    const { app } = await appNueva();
    sinon.stub(redis, 'ping').rejects(new Error('sin conexión'));
    try {
      const res = await request(app).get('/api/v1/salud').expect(200);
      expect(res.body.data.estado).to.equal('degradado');
      expect(res.body.data.servicios).to.deep.equal({
        postgres: 'ok',
        redis: 'error',
        worker: 'desconocido',
      });
      expect(res.body.message).to.match(/Redis/);
    } finally {
      sinon.restore();
    }
  });

  it('el latido del worker se ve en GET /api/v1/salud y se quita al cerrarlo', async () => {
    const { app } = await appNueva();
    const latido = iniciarLatido();
    try {
      await new Promise((listo) => setTimeout(listo, 50)); // el primer latido es inmediato
      const encendido = await request(app).get('/api/v1/salud').expect(200);
      expect(encendido.body.data.servicios.worker).to.equal('ok');
    } finally {
      await latido.cerrar();
    }
    const apagado = await request(app).get('/api/v1/salud').expect(200);
    expect(apagado.body.data.servicios.worker).to.equal('sin_respuesta');
  });

  it('GET /api/v1/salud avisa si el worker no responde, pero sigue en 200 porque la caja vende', async () => {
    const { app } = await appNueva();
    const res = await request(app).get('/api/v1/salud').expect(200);
    expect(res.body.data.estado).to.equal('degradado');
    expect(res.body.data.servicios).to.deep.equal({ postgres: 'ok', redis: 'ok', worker: 'sin_respuesta' });
    expect(res.body.message).to.equal(
      'Servicio disponible; el worker no responde: avisos, respaldos y reportes quedan en espera',
    );
  });

  it('una ruta inexistente responde 404 con formato RFC 7807 en español', async () => {
    const { app } = await appNueva();
    const res = await request(app).get('/api/v1/no-existe').expect(404);
    expect(res.headers['content-type']).to.match(/application\/problem\+json/);
    expect(res.body).to.include({ status: 404, title: 'Recurso no encontrado' });
    expect(res.body.instance).to.equal('/api/v1/no-existe');
  });

  it('un JSON mal formado responde 400 sin exponer detalles internos', async () => {
    const { app } = await appNueva();
    const res = await request(app)
      .post('/api/v1/categorias')
      .set('Content-Type', 'application/json')
      .send('{"nombre": ')
      .expect(400);
    expect(res.body.title).to.equal('Solicitud inválida');
    expect(res.body.detail).to.match(/JSON/);
  });

  it('agrega cabeceras de seguridad de helmet', async () => {
    const { app } = await appNueva();
    const res = await request(app).get('/api/v1/salud');
    expect(res.headers['x-content-type-options']).to.equal('nosniff');
    expect(res.headers['content-security-policy']).to.be.a('string');
    expect(res.headers).to.not.have.property('x-powered-by');
  });

  it('CORS solo permite el origen de la PWA', async () => {
    const { app } = await appNueva();
    const permitido = await request(app).get('/api/v1/salud').set('Origin', 'http://localhost:8080');
    expect(permitido.headers['access-control-allow-origin']).to.equal('http://localhost:8080');
    const ajeno = await request(app).get('/api/v1/salud').set('Origin', 'http://otro-sitio.com');
    expect(ajeno.headers).to.not.have.property('access-control-allow-origin');
  });

  it('publica la especificación OpenAPI 3 con las rutas del catálogo', async () => {
    const { app } = await appNueva();
    const res = await request(app).get('/api-docs.json').expect(200);
    expect(res.body.openapi).to.match(/^3\.0/);
    expect(res.body.components.securitySchemes.tokenAcceso).to.include({ scheme: 'bearer' });
    expect(res.body.paths).to.have.property('/api/v1/productos');
    expect(res.body.paths).to.have.property('/api/v1/productos/codigo/{codigo}');
    expect(res.body.paths['/api/v1/productos'].post.responses).to.have.keys(
      '201',
      '400',
      '401',
      '403',
      '409',
      '422',
      '500',
    );
  });

  it('Swagger guarda el token al iniciar sesión y lo conserva al recargar la página', async () => {
    const { app } = await appNueva();
    const res = await request(app).get('/api-docs/swagger-ui-init.js').expect(200);
    expect(res.text).to.include('"persistAuthorization": true');
    expect(res.text).to.match(/responseInterceptor[\s\S]*preauthorizeApiKey/);
  });

  it('sirve Swagger UI en /api-docs', async () => {
    const { app } = await appNueva();
    const res = await request(app).get('/api-docs/').expect(200);
    expect(res.text).to.match(/swagger-ui/i);
  });

  it('un cuerpo mayor al límite responde 413', async () => {
    const { app } = await appNueva();
    const res = await request(app)
      .post('/api/v1/categorias')
      .send({ nombre: 'x'.repeat(200_000) })
      .expect(413);
    expect(res.body.title).to.equal('Solicitud demasiado grande');
  });

  it('un error inesperado responde 500 sin exponer el mensaje interno', async () => {
    const { api } = await appDePrueba();
    sinon
      .stub(CatalogoServicio.prototype, 'listarCategorias')
      .rejects(new Error('conexión perdida con la base de datos'));
    const consola = sinon.stub(console, 'error');
    try {
      const res = await api.get('/api/v1/categorias').expect(500);
      expect(res.body.detail).to.not.match(/base de datos/);
      expect(consola.calledOnce).to.equal(true);
    } finally {
      sinon.restore();
    }
  });
});
