/**
 * Cola "programadas": la revisión de caducidades corre todos los días a la hora de HORA_REVISION y,
 * si al arrancar la de hoy está pendiente, se hace en ese momento. La vigencia de las promociones se
 * pone al día al empezar cada día y al arrancar. Al terminar se avisa a las pantallas. Solo la carga
 * el worker.
 */
import type { Queue, Worker } from 'bullmq';
import { configuracion } from '../config';
import { ZONA_HORARIA } from '../comun/fechas';
import { avisarDesdeWorker } from '../comun/tiempo-real';
import { crearCola, crearWorker } from '../infraestructura/colas';
import { InventarioServicio } from '../modulos/inventario/inventario';
import { PromocionesServicio } from '../modulos/promociones/promociones';

const COLA = 'programadas';
const REVISION = 'revision-caducidades';
const VIGENCIA = 'vigencia-promociones';

export async function iniciarProgramadas(): Promise<{ cola: Queue; worker: Worker }> {
  const inventario = new InventarioServicio();
  const promociones = new PromocionesServicio();
  const cola = crearCola(COLA);

  // Todos los días a la hora configurada, en la hora de la tienda.
  const [hora, minuto] = configuracion.horaRevision.split(':').map(Number);
  await cola.upsertJobScheduler(
    REVISION,
    { pattern: `${minuto} ${hora} * * *`, tz: ZONA_HORARIA },
    { name: REVISION },
  );

  // Las promociones son por días completos: con revisarlas al empezar cada día basta.
  await cola.upsertJobScheduler(VIGENCIA, { pattern: '0 0 * * *', tz: ZONA_HORARIA }, { name: VIGENCIA });

  // Por si la PC estaba apagada a esa hora.
  if (await inventario.revisionPendiente()) await cola.add(REVISION, {});
  await cola.add(VIGENCIA, {});

  const worker = crearWorker(COLA, async (job) => {
    if (job.name === REVISION) {
      const resumen = await inventario.revisarCaducidades();
      if (resumen) avisarDesdeWorker('alertas:actualizadas');
      return resumen;
    }
    if (job.name === VIGENCIA) {
      const cambios = await promociones.conciliar();
      if (cambios > 0) avisarDesdeWorker('promocion:cambio');
      return cambios;
    }
    throw new Error(`Trabajo desconocido: ${job.name}`);
  });
  return { cola, worker };
}
