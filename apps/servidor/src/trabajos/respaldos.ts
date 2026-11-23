/**
 * Cola "respaldos": el worker hace el pg_dump que pidió el cierre de caja. Si falla, queda FALLIDO y
 * se avisa a las pantallas. Solo la carga el worker.
 */
import type { Job } from 'bullmq';
import { avisarDesdeWorker } from '../comun/tiempo-real';
import { crearWorker } from '../infraestructura/colas';
import {
  cerrarColaDeRespaldos,
  COLA_RESPALDOS,
  publicarRespaldo,
  RespaldosServicio,
} from '../modulos/respaldos/respaldos';

export async function iniciarRespaldos(): Promise<{ cerrar: () => Promise<void> }> {
  const servicio = new RespaldosServicio();
  const worker = crearWorker(COLA_RESPALDOS, async (job: Job<{ respaldoId: string }>) => {
    const respaldo = await servicio.generar(job.data.respaldoId);
    console.log(`Respaldo ${respaldo.archivo} listo (${respaldo.bytes} bytes)`);
  });
  // crearWorker ya apunta el motivo en la consola; aquí solo se avisa a las pantallas.
  worker.on('failed', () => avisarDesdeWorker('respaldo:resultado'));

  // Lo que no alcanzó a llegar a la cola, por ejemplo porque Redis estaba caído.
  for (const respaldo of await servicio.pendientes()) await publicarRespaldo(respaldo.id);

  return {
    cerrar: async () => {
      await worker.close();
      await cerrarColaDeRespaldos();
    },
  };
}
