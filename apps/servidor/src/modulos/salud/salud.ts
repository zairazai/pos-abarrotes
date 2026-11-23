/**
 * Módulo salud: GET /api/v1/salud dice si la API, PostgreSQL, Redis y el worker responden, junto con
 * la versión, cuánto lleva encendida y la memoria que usa. Es pública para que Docker la pueda
 * consultar sin sesión. Sin PostgreSQL responde 503; sin Redis o sin worker, 200 "degradado", porque
 * la caja sigue vendiendo.
 */
import { Router } from 'express';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { documentar } from '../../comun/documentar';
import { fuenteDatos } from '../../infraestructura/base-datos/fuente';
import { claveRedis, redis, redisResponde } from '../../infraestructura/redis';

/** Bytes a megabytes con un decimal. */
const mb = (bytes: number) => Math.round((bytes / 1024 / 1024) * 10) / 10;

// --- Latido del worker ---
// El worker deja en Redis una marca que dura 60 s y la renueva cada 20 s. Si no está, el worker está apagado.

const SEGUNDOS_LATIDO = 60;
const claveLatido = () => claveRedis('worker:latido');

/** Lo llama el worker al arrancar y cada 20 segundos. */
export async function latir(): Promise<void> {
  await redis.set(claveLatido(), new Date().toISOString(), { EX: SEGUNDOS_LATIDO });
}

/** Lo llama el worker al apagarse, para que la API se entere luego luego. */
export async function apagarLatido(): Promise<void> {
  await redis.del(claveLatido()).catch(() => undefined);
}

async function estadoWorker(): Promise<'ok' | 'sin_respuesta' | 'desconocido'> {
  try {
    return (await redis.exists(claveLatido())) === 1 ? 'ok' : 'sin_respuesta';
  } catch {
    return 'desconocido'; // sin Redis no hay forma de saberlo
  }
}

// --- Ruta ---

export function rutasSalud(version: string): Router {
  const router = Router();

  router.get('/salud', async (_req, res) => {
    // Consulta mínima, solo para ver si PostgreSQL contesta.
    const postgres = await fuenteDatos.query('SELECT 1').then(
      () => 'ok' as const,
      () => 'error' as const,
    );
    const redis = (await redisResponde()) ? ('ok' as const) : ('error' as const);
    const worker = redis === 'ok' ? await estadoWorker() : ('desconocido' as const);
    const sano = postgres === 'ok';
    const memoria = process.memoryUsage();

    let mensaje = 'Servicio disponible';
    if (!sano) mensaje = 'Uno o más servicios no responden';
    else if (redis === 'error') mensaje = 'Servicio disponible sin Redis; se trabaja solo con PostgreSQL';
    else if (worker !== 'ok') {
      mensaje = 'Servicio disponible; el worker no responde: avisos, respaldos y reportes quedan en espera';
    }

    res.status(sano ? 200 : 503).json({
      success: sano,
      data: {
        estado: sano && redis === 'ok' && worker === 'ok' ? 'ok' : 'degradado',
        version,
        tiempoActivoSegundos: Math.round(process.uptime()),
        memoria: { rssMb: mb(memoria.rss), heapUsadoMb: mb(memoria.heapUsed) },
        servicios: { postgres, redis, worker },
      },
      message: mensaje,
    });
  });

  return router;
}

// --- Swagger ---

const esquemaSalud = z.object({
  estado: z.enum(['ok', 'degradado']),
  version: z.string(),
  tiempoActivoSegundos: z.number(),
  memoria: z.object({ rssMb: z.number(), heapUsadoMb: z.number() }),
  servicios: z.object({
    postgres: z.enum(['ok', 'error']),
    redis: z.enum(['ok', 'error']),
    worker: z.enum(['ok', 'sin_respuesta', 'desconocido']),
  }),
});

export function documentarSalud(registro: OpenAPIRegistry): void {
  documentar(registro, [
    {
      metodo: 'get',
      ruta: '/salud',
      resumen: 'Estado de la API, PostgreSQL, Redis y el worker',
      etiqueta: 'Salud',
      publica: true,
      respuesta: esquemaSalud,
      errores: [503],
    },
  ]);
}
