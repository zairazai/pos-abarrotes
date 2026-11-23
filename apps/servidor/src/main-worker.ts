/**
 * Arranque del worker (npm run worker): se conecta a PostgreSQL y atiende las colas de BullMQ en un
 * proceso aparte de la API. Si el worker se cae, la caja sigue vendiendo como si nada. Con Ctrl+C o
 * con la señal de Docker, termina lo que estaba haciendo y se apaga.
 */

// El .env se carga antes que nada, igual que en main-api.ts.
import { config as cargarEnv } from 'dotenv';
cargarEnv({ path: ['.env', '../../.env'], quiet: true });

import { cerrarEmisor, iniciarEmisor } from './comun/tiempo-real';
import { fuenteDatos } from './infraestructura/base-datos/fuente';
import { cerrarConexionesDeColas } from './infraestructura/colas';
import { conectarRedis, redis } from './infraestructura/redis';
import { iniciarBot } from './trabajos/bot';
import { iniciarEnvios } from './trabajos/envios';
import { iniciarLatido } from './trabajos/latido';
import { iniciarProgramadas } from './trabajos/programadas';
import { iniciarReportes } from './trabajos/reportes';
import { iniciarRespaldos } from './trabajos/respaldos';

async function iniciar(): Promise<void> {
  await fuenteDatos.initialize();
  // Los avisos del worker llegan a las pantallas pasando por Redis y la API.
  iniciarEmisor();
  // El bot guarda en Redis en qué paso va cada conversación y el código del Dueño.
  void conectarRedis();

  // Cada cola agrega aquí su worker.
  const programadas = await iniciarProgramadas();
  const envios = await iniciarEnvios();
  const respaldos = await iniciarRespaldos();
  const reportes = await iniciarReportes();
  const bot = iniciarBot();
  // GET /salud sabe que el worker está vivo gracias a esta marca en Redis.
  const latido = iniciarLatido();
  const workers = [programadas.worker];
  const colas = [programadas.cola];
  console.log('Worker del POS en espera de trabajos');

  // Apagado en orden: cada worker termina el trabajo que trae antes de cerrar.
  const cerrar = (senal: string) => {
    console.log(`Señal ${senal} recibida; cerrando el worker…`);
    latido
      .cerrar()
      .then(() => bot.cerrar())
      .then(() => Promise.all(workers.map((w) => w.close())))
      .then(() => Promise.all(colas.map((c) => c.close())))
      .then(() => envios.cerrar())
      .then(() => respaldos.cerrar())
      .then(() => reportes.cerrar())
      .then(() => {
        cerrarConexionesDeColas();
        cerrarEmisor();
        if (redis.isOpen) redis.destroy();
      })
      .finally(() => fuenteDatos.destroy().finally(() => process.exit(0)));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => cerrar('SIGTERM'));
  process.on('SIGINT', () => cerrar('SIGINT'));
}

iniciar().catch((error: Error) => {
  console.error(`No se pudo iniciar el worker: ${error.message}`);
  process.exit(1);
});
