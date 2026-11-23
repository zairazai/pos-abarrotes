/**
 * Latido del worker: cada 20 segundos deja en Redis la marca que revisa GET /salud. Si Redis no
 * responde, se intenta en la siguiente vuelta. Solo lo carga el worker.
 */
import { redis } from '../infraestructura/redis';
import { apagarLatido, latir } from '../modulos/salud/salud';

const SEGUNDOS_ENTRE_LATIDOS = 20;

export function iniciarLatido(): { cerrar: () => Promise<void> } {
  const latido = () => void latir().catch(() => undefined);
  latido();
  // Al arrancar, Redis puede no estar listo; en cuanto conecta (o reconecta) se late sin esperar.
  redis.on('ready', latido);
  const intervalo = setInterval(latido, SEGUNDOS_ENTRE_LATIDOS * 1000);
  return {
    cerrar: async () => {
      clearInterval(intervalo);
      redis.off('ready', latido);
      await apagarLatido();
    },
  };
}
