/**
 * Colas de BullMQ: la API deja trabajos y el worker los hace aparte, para que la caja nunca se quede
 * esperando una tarea lenta. Cada trabajo tiene 3 intentos, con una espera que va creciendo. Usan el
 * mismo Redis y el mismo paquete redis que la caché.
 */
import { createClient } from 'redis';
import { createNodeRedisClient, Queue, Worker, type Job, type Processor } from 'bullmq';
import { configuracion } from '../config';
import { claveRedis } from './redis';

/** Intentos y espera: el primer reintento a los 5 s, el segundo a los 10 s. */
const OPCIONES_TRABAJO = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5000 },
  removeOnComplete: 100, // solo se guardan los últimos 100 terminados
  removeOnFail: 1000, // los fallidos se conservan para revisarlos
};

// BullMQ no cierra una conexión que se le pasa ya creada; por eso se guardan, para cerrarlas al apagar.
const conexiones: ReturnType<typeof createClient>[] = [];

/** Cada cola y cada worker abren su propia conexión; el prefijo separa las bases. */
function opcionesBase() {
  const cliente = createClient({ url: configuracion.redisUrl });
  // Sin esto, un error de conexión tumbaría el proceso; del aviso en consola ya se encarga redis.ts.
  cliente.on('error', () => undefined);
  conexiones.push(cliente);
  return { connection: createNodeRedisClient(cliente), prefix: claveRedis('bull') };
}

/** Cierra las conexiones de las colas; se llama después de cerrar colas y workers. */
export function cerrarConexionesDeColas(): void {
  for (const cliente of conexiones.splice(0)) if (cliente.isOpen) cliente.destroy();
}

export function crearCola(nombre: string): Queue {
  const cola = new Queue(nombre, { ...opcionesBase(), defaultJobOptions: OPCIONES_TRABAJO });
  cola.on('error', () => undefined);
  return cola;
}

/** Worker de una cola. Si un trabajo se acaba sus intentos, se avisa en la consola. */
export function crearWorker(nombre: string, procesador: Processor): Worker {
  const worker = new Worker(nombre, procesador, opcionesBase());
  worker.on('error', () => undefined);
  worker.on('failed', (job: Job | undefined, error: Error) => {
    if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
      console.error(
        `Trabajo ${nombre}/${job.name} fallido tras ${job.attemptsMade} intentos: ${error.message}`,
      );
    }
  });
  return worker;
}
