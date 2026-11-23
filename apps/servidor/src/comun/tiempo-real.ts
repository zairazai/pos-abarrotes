/**
 * Avisos en tiempo real con Socket.io. La conexión se autentica con el token de acceso, igual que las
 * rutas, y todos entran a la sala "tienda" porque solo hay una caja. Además, cada usuario entra a su
 * propia sala, para poder avisarle solo a él.
 * El worker no tiene Socket.io: deja sus avisos en Redis (redis-emitter) y la API los reparte con el
 * adaptador de Redis.
 * Uso: emitir('alertas:actualizadas') en la API; avisarDesdeWorker('alertas:actualizadas') en el worker.
 */
import type { Server as ServidorHttp } from 'node:http';
import { createAdapter } from '@socket.io/redis-adapter';
import { Emitter } from '@socket.io/redis-emitter';
import { createClient } from 'redis';
import { Server } from 'socket.io';
import { configuracion } from '../config';
import { claveRedis } from '../infraestructura/redis';
import { AccesoServicio } from '../modulos/acceso/acceso';
import { Prohibido } from './errores';
import type { SesionActual } from './sesion';

/** Eventos que manda el servidor, con sus datos. */
interface EventosServidor {
  'alertas:actualizadas': () => void; // la pantalla vuelve a pedir GET /inventario/alertas
  'sesion:revocada': (datos: { usuarioId: string }) => void;
  'promocion:cambio': () => void; // una promoción se activó o venció; la pantalla recarga las vigentes
  'envio:resultado': () => void; // un envío quedó como fallido; la pantalla consulta GET /envios
  'respaldo:resultado': () => void; // falló un respaldo; la pantalla consulta GET /respaldos
  // Solo para quien pidió la exportación: ya se puede descargar, o falló.
  'reporte:listo': (datos: { exportacionId: string; estado: 'LISTO' | 'FALLIDO' }) => void;
}

/** Avisos que van a toda la tienda, sin datos. */
type AvisoTienda = 'alertas:actualizadas' | 'promocion:cambio' | 'envio:resultado' | 'respaldo:resultado';

export const SALA_TIENDA = 'tienda';
const salaUsuario = (usuarioId: string) => `usuario:${usuarioId}`;

let io: Server<
  Record<string, never>,
  EventosServidor,
  Record<string, never>,
  { sesion: SesionActual }
> | null = null;
let emisor: Emitter<EventosServidor> | null = null;
const conexiones: ReturnType<typeof createClient>[] = [];

/**
 * Conexión a Redis para el adaptador y el emisor. Sin Redis, lo publicado se queda formado hasta que
 * vuelva (no truena): estos paquetes no esperan respuesta y un error tumbaría el proceso. Del aviso
 * en consola cuando Redis no responde ya se encarga el cliente principal de redis.ts.
 */
function conexion(): ReturnType<typeof createClient> {
  const cliente = createClient({ url: configuracion.redisUrl });
  cliente.on('error', () => undefined);
  cliente.connect().catch(() => undefined);
  conexiones.push(cliente);
  return cliente;
}

/** Los canales llevan el nombre de la base, como las demás claves. */
const opcionesRedis = () => ({ key: claveRedis('socket.io') });

export function iniciarTiempoReal(servidor: ServidorHttp): void {
  io = new Server(servidor, { cors: { origin: configuracion.origenesPermitidos } });
  io.adapter(createAdapter(conexion(), conexion(), opcionesRedis()));

  // El token viene en socket.handshake.auth.token; si no sirve, el cliente recibe connect_error.
  io.use(async (socket, next) => {
    try {
      const sesion = await new AccesoServicio().verificar(String(socket.handshake.auth.token ?? ''));
      if (sesion.debeCambiarPin) throw new Prohibido('Antes de continuar debe cambiar su PIN temporal');
      socket.data.sesion = sesion;
      next();
    } catch (error) {
      next(error as Error);
    }
  });

  io.on('connection', (socket) => {
    void socket.join([SALA_TIENDA, salaUsuario(socket.data.sesion.usuarioId)]);
  });
}

/** Avisa a toda la tienda. Si Socket.io no está encendido (pruebas, worker), no hace nada. */
export function emitir(evento: AvisoTienda): void {
  io?.to(SALA_TIENDA).emit(evento);
}

/** Avisa al usuario desactivado y cierra sus conexiones. */
export function revocarSesiones(usuarioId: string): void {
  if (!io) return;
  io.to(salaUsuario(usuarioId)).emit('sesion:revocada', { usuarioId });
  io.in(salaUsuario(usuarioId)).disconnectSockets(true);
}

// --- Desde el worker ---

export function iniciarEmisor(): void {
  emisor = new Emitter<EventosServidor>(conexion(), opcionesRedis());
}

/** Avisa a toda la tienda desde el worker. Si el emisor no está iniciado, no hace nada. */
export function avisarDesdeWorker(evento: AvisoTienda): void {
  emisor?.to(SALA_TIENDA).emit(evento);
}

/** Le avisa solo a quien pidió una exportación que ya terminó. */
export function avisarReporteDesdeWorker(
  usuarioId: string,
  datos: { exportacionId: string; estado: 'LISTO' | 'FALLIDO' },
): void {
  emisor?.to(salaUsuario(usuarioId)).emit('reporte:listo', datos);
}

// --- Cierre ---

/** Cierra Socket.io, el servidor HTTP que lo lleva y las conexiones a Redis del adaptador. */
export async function cerrarTiempoReal(): Promise<void> {
  if (!io) return;
  await io.close();
  io = null;
  cerrarConexiones();
}

export function cerrarEmisor(): void {
  emisor = null;
  cerrarConexiones();
}

function cerrarConexiones(): void {
  for (const cliente of conexiones.splice(0)) if (cliente.isOpen) cliente.destroy();
}
