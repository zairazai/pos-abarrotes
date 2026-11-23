/**
 * Conexión a Redis 7 con el paquete redis. Si Redis no responde, la API sigue con PostgreSQL: la
 * caché nunca es la única fuente de los datos.
 */
import { createClient } from 'redis';
import { configuracion } from '../config';
import { fuenteDatos } from './base-datos/fuente';

export const redis = createClient({
  url: configuracion.redisUrl,
  // Sin conexión, los comandos fallan luego luego en lugar de quedarse esperando.
  disableOfflineQueue: true,
  // Reintenta cada vez más despacio, hasta cada 5 segundos.
  socket: { reconnectStrategy: (intentos) => Math.min(intentos * 200, 5000) },
});

// Se avisa solo al perder y al recuperar la conexión, no en cada reintento (si no, llena la consola).
let avisado = false;
redis.on('error', (error: Error) => {
  if (avisado) return;
  avisado = true;
  console.warn(`Redis no responde; se trabaja solo con PostgreSQL (${error.message})`);
});
redis.on('ready', () => {
  if (avisado) console.log('Redis responde de nuevo');
  avisado = false;
});

/**
 * Clave con el nombre de la base al principio, para que desarrollo, práctica y pruebas no se revuelvan
 * en el mismo Redis.
 */
export const claveRedis = (nombre: string) => `${String(fuenteDatos.options.database)}:${nombre}`;

/** Abre la conexión; si Redis está apagado, sigue intentando por detrás sin detener la API. */
export function conectarRedis(): Promise<void> {
  return redis.connect().then(
    () => undefined,
    () => undefined,
  );
}

/** Dice si Redis contesta. */
export async function redisResponde(): Promise<boolean> {
  try {
    await redis.ping();
    return true;
  } catch {
    return false;
  }
}
