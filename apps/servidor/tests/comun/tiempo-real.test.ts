import { expect } from 'chai';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import { io as cliente, type Socket } from 'socket.io-client';
import {
  avisarDesdeWorker,
  cerrarEmisor,
  cerrarTiempoReal,
  iniciarEmisor,
  iniciarTiempoReal,
} from '../../src/comun/tiempo-real';
import { fuenteDatos } from '../../src/infraestructura/base-datos/fuente';
import { redis } from '../../src/infraestructura/redis';
import { iniciarProgramadas } from '../../src/trabajos/programadas';
import { appDePrueba, appNueva, iniciarSesion, PIN_INICIAL, productoValido } from '../ayuda';

let servidor: Server;
let url: string;
const abiertos: Socket[] = [];

/** Arranca la API en un puerto libre con Socket.io, como main-api.ts. */
function escuchar(app: Express): void {
  servidor = app.listen(0);
  iniciarTiempoReal(servidor);
  url = `http://localhost:${(servidor.address() as AddressInfo).port}`;
}

/** Se conecta con el token; resuelve al conectarse y rechaza con el motivo si no lo dejan. */
function conectar(token?: string): Promise<Socket> {
  const socket = cliente(url, {
    auth: token ? { token } : {},
    transports: ['websocket'],
    reconnection: false,
  });
  abiertos.push(socket);
  return new Promise((listo, falla) => {
    socket.on('connect', () => listo(socket));
    socket.on('connect_error', (error) => falla(error));
  });
}

/** Espera a que el adaptador de la API esté suscrito en Redis, para no perder el primer aviso. */
async function adaptadorSuscrito(): Promise<void> {
  while (Number(await redis.sendCommand(['PUBSUB', 'NUMPAT'])) === 0) {
    await new Promise((listo) => setTimeout(listo, 20));
  }
}

/** Espera un evento del servidor. */
const recibir = <T = unknown>(socket: Socket, evento: string) =>
  new Promise<T>((listo) => socket.once(evento, (datos: T) => listo(datos)));

describe('Tiempo real con Socket.io', () => {
  afterEach(async () => {
    for (const s of abiertos.splice(0)) s.disconnect();
    await cerrarTiempoReal();
    cerrarEmisor();
  });

  it('sin token o con un token inválido no deja conectarse', async () => {
    const { app } = await appDePrueba();
    escuchar(app);
    const sinToken = await conectar().catch((e: Error) => e);
    expect((sinToken as Error).message).to.match(/inicie sesión/);
    const invalido = await conectar('no-es-un-token').catch((e: Error) => e);
    expect((invalido as Error).message).to.match(/inicie sesión/);
  });

  it('con el PIN temporal no deja conectarse hasta cambiarlo', async () => {
    const { app } = await appNueva();
    escuchar(app);
    const temporal = await iniciarSesion(app, PIN_INICIAL);
    const error = await conectar(temporal).catch((e: Error) => e);
    expect((error as Error).message).to.match(/cambiar su PIN/);
  });

  it('Dueño y Empleado reciben alertas:actualizadas en la sala tienda tras un ajuste', async () => {
    const { app, api, tokenDueno, tokenEmpleado } = await appDePrueba();
    escuchar(app);
    const dueno = await conectar(tokenDueno);
    const empleado = await conectar(tokenEmpleado);
    const avisos = Promise.all([
      recibir(dueno, 'alertas:actualizadas'),
      recibir(empleado, 'alertas:actualizadas'),
    ]);

    const [categoria] = await fuenteDatos.query(`SELECT id FROM categoria WHERE nombre = 'Abarrotes'`);
    const producto = await api
      .post('/api/v1/productos')
      .send({ ...productoValido, categoriaId: categoria.id })
      .expect(201);
    await api
      .post('/api/v1/inventario/ajustes')
      .send({ productoId: producto.body.data.id, contada: '5' })
      .expect(201);

    // Solo es el aviso: la pantalla vuelve a pedir GET /inventario/alertas.
    expect(await avisos).to.deep.equal([undefined, undefined]);
  });

  it('al desactivar a un usuario conectado recibe sesion:revocada y se desconecta', async () => {
    const { app, api, tokenEmpleado, empleadoId } = await appDePrueba();
    escuchar(app);
    const empleado = await conectar(tokenEmpleado);
    const aviso = recibir<{ usuarioId: string }>(empleado, 'sesion:revocada');
    const desconexion = recibir<string>(empleado, 'disconnect');

    await api.patch(`/api/v1/usuarios/${empleadoId}/desactivar`).expect(200);
    expect(await aviso).to.deep.equal({ usuarioId: empleadoId });
    expect(await desconexion).to.equal('io server disconnect');
  });

  it('una promoción que empieza hoy avisa promocion:cambio', async () => {
    const { app, api, tokenEmpleado } = await appDePrueba();
    escuchar(app);
    const empleado = await conectar(tokenEmpleado);
    const aviso = recibir(empleado, 'promocion:cambio');

    const [categoria] = await fuenteDatos.query(`SELECT id FROM categoria WHERE nombre = 'Abarrotes'`);
    const producto = await api
      .post('/api/v1/productos')
      .send({ ...productoValido, categoriaId: categoria.id })
      .expect(201);
    await api
      .post('/api/v1/promociones')
      .send({
        productoId: producto.body.data.id,
        tipo: 'PRECIO_ESPECIAL',
        precio: '30.00',
        inicio: '2026-10-17',
        fin: '2026-10-17',
      })
      .expect(201);
    expect(await aviso).to.equal(undefined);
  });

  describe('avisos desde el worker por Redis', () => {
    it('un aviso que publica el worker llega a los clientes de la API', async () => {
      const { app, tokenEmpleado } = await appDePrueba();
      escuchar(app);
      const empleado = await conectar(tokenEmpleado);
      await adaptadorSuscrito();
      iniciarEmisor();

      const aviso = recibir(empleado, 'alertas:actualizadas');
      avisarDesdeWorker('alertas:actualizadas');
      expect(await aviso).to.equal(undefined);
    });

    it('al terminar la revisión de caducidades, el worker avisa alertas:actualizadas', async () => {
      const { app, tokenDueno } = await appDePrueba();
      escuchar(app);
      const dueno = await conectar(tokenDueno);
      await adaptadorSuscrito();
      iniciarEmisor();

      const aviso = recibir(dueno, 'alertas:actualizadas');
      const { cola, worker } = await iniciarProgramadas();
      try {
        expect(await aviso).to.equal(undefined);
      } finally {
        await worker.close();
        await cola.close();
      }
    });
  });
});
