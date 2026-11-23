/**
 * Cola "reportes": el worker hace el PDF o el Excel con hasta 3 intentos. Al terminar, o al acabarse
 * los intentos, le avisa solo a quien lo pidió. Solo la carga el worker.
 */
import type { Job } from 'bullmq';
import { avisarReporteDesdeWorker } from '../comun/tiempo-real';
import { crearWorker } from '../infraestructura/colas';
import {
  cerrarColaDeReportes,
  COLA_REPORTES,
  ExportacionesServicio,
  publicarExportacion,
} from '../modulos/reportes/reportes';

export async function iniciarReportes(): Promise<{ cerrar: () => Promise<void> }> {
  const servicio = new ExportacionesServicio();
  const worker = crearWorker(COLA_REPORTES, async (job: Job<{ exportacionId: string }>) => {
    const exportacion = await servicio.generar(job.data.exportacionId);
    avisarReporteDesdeWorker(exportacion.usuarioId, { exportacionId: exportacion.id, estado: 'LISTO' });
  });
  worker.on('failed', (job: Job | undefined, error: Error) => {
    if (!job || job.attemptsMade < (job.opts.attempts ?? 1)) return; // todavía se reintenta
    const id = job.data.exportacionId as string;
    servicio
      .marcarFallido(id, error.message)
      .then(() => servicio.pedido(id))
      .then((e) => e && avisarReporteDesdeWorker(e.usuarioId, { exportacionId: id, estado: 'FALLIDO' }))
      .catch((e: Error) => console.error(`No se pudo marcar la exportación como fallida: ${e.message}`));
  });

  // Lo que no alcanzó a llegar a la cola, por ejemplo porque Redis estaba caído.
  for (const exportacion of await servicio.pendientes()) await publicarExportacion(exportacion.id);

  return {
    cerrar: async () => {
      await worker.close();
      await cerrarColaDeReportes();
    },
  };
}
