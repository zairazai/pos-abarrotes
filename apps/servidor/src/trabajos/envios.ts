/**
 * Colas "correo" y "telegram": mandan cada envío con hasta 3 intentos y, si se acaban, lo dejan como
 * fallido. Sin internet se pausan, para no gastar intentos de a gratis. Solo las carga el worker.
 */
import { lookup } from 'node:dns/promises';
import type { Job, Queue } from 'bullmq';
import { CANALES_ENVIO } from '@pos/compartido';
import { avisarDesdeWorker } from '../comun/tiempo-real';
import { crearCola, crearWorker } from '../infraestructura/colas';
import { hayEnvioReal } from '../infraestructura/mensajeria';
import {
  cerrarColasDeEnvio,
  COLAS_ENVIO,
  NotificacionesServicio,
  publicarEnvio,
} from '../modulos/notificaciones/notificaciones';

const SEGUNDOS_REVISION = 60;

/** Pausa las colas cuando no hay internet y las reanuda cuando regresa. */
export async function ajustarColas(colas: Pick<Queue, 'pause' | 'resume'>[], hayInternet: boolean) {
  await Promise.all(colas.map((c) => (hayInternet ? c.resume() : c.pause())));
}

const hayInternet = () =>
  lookup('api.telegram.org').then(
    () => true,
    () => false,
  );

/** Arranca los workers, recoge lo pendiente y regresa cómo cerrarlos. */
export async function iniciarEnvios(): Promise<{ cerrar: () => Promise<void> }> {
  const servicio = new NotificacionesServicio();
  const workers = CANALES_ENVIO.map((canal) => {
    const worker = crearWorker(COLAS_ENVIO[canal], (job: Job<{ envioId: string }>) =>
      servicio.procesar(job.data.envioId, job.attemptsMade + 1),
    );
    worker.on('failed', (job: Job | undefined, error: Error) => {
      if (!job || job.attemptsMade < (job.opts.attempts ?? 1)) return;
      servicio.marcarFallido(job.data.envioId, job.attemptsMade, error.message).then(
        () => avisarDesdeWorker('envio:resultado'),
        (e: Error) => console.error(`No se pudo marcar el envío como fallido: ${e.message}`),
      );
    });
    return worker;
  });

  // Lo que no alcanzó a llegar a la cola, por ejemplo porque Redis estaba caído.
  for (const envio of await servicio.pendientes()) await publicarEnvio(envio.canal, envio.id);

  // Si todo es simulado, no hace falta internet. Estas colas aparte solo sirven para pausar y reanudar.
  const pausables = hayEnvioReal() ? CANALES_ENVIO.map((canal) => crearCola(COLAS_ENVIO[canal])) : [];
  const revision = hayEnvioReal()
    ? setInterval(() => {
        void hayInternet().then((conexion) => ajustarColas(pausables, conexion));
      }, SEGUNDOS_REVISION * 1000)
    : null;

  return {
    cerrar: async () => {
      if (revision) clearInterval(revision);
      await Promise.all(workers.map((w) => w.close()));
      await Promise.all(pausables.map((c) => c.close()));
      await cerrarColasDeEnvio();
    },
  };
}
