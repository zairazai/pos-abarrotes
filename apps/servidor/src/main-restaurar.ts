/**
 * Restaurar un respaldo: npm run respaldo:restaurar -- <archivo> --si
 * Borra los datos actuales de la base del .env y pone los del respaldo, todo en una sola transacción.
 * Antes hay que detener la API y el worker; si siguen conectados, no se restaura nada.
 * Al terminar, el respaldo usado queda CORRECTO y se borra la caché de Redis de esa base.
 * No está en la API a propósito: un error ahí podría borrar los datos de la tienda.
 */

// El .env se carga antes que nada, igual que en main-api.ts.
import { config as cargarEnv } from 'dotenv';
cargarEnv({ path: ['.env', '../../.env'], quiet: true });

import { existsSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import { configuracion } from './config';
import { fuenteDatos } from './infraestructura/base-datos/fuente';
import { vaciarCache } from './infraestructura/cache';
import { conectarRedis, redis } from './infraestructura/redis';
import { herramientas } from './infraestructura/respaldo';
import { RespaldosServicio } from './modulos/respaldos/respaldos';

async function restaurar(): Promise<void> {
  const argumentos = process.argv.slice(2);
  const nombre = argumentos.find((a) => !a.startsWith('--'));
  if (!nombre) throw new Error('Indique el archivo: npm run respaldo:restaurar -- <archivo> --si');

  // Se acepta la ruta completa o solo el nombre del archivo que está en la carpeta de respaldos.
  const archivo = isAbsolute(nombre) ? nombre : join(configuracion.respaldos.carpeta, nombre);
  if (!existsSync(archivo)) throw new Error(`No existe el archivo ${archivo}`);

  const base = String(fuenteDatos.options.database);
  if (!argumentos.includes('--si')) {
    console.log(`Esto BORRA los datos actuales de la base "${base}" y los cambia por los de ${archivo}.`);
    console.log('Detenga la API y el worker y repita el comando agregando --si.');
    process.exitCode = 1;
    return;
  }

  // Mientras se restaura, nadie más puede estar usando la base.
  await fuenteDatos.initialize();
  const [{ otras }] = await fuenteDatos.query(
    `SELECT count(*)::int AS otras FROM pg_stat_activity
     WHERE datname = current_database() AND pid <> pg_backend_pid()`,
  );
  await fuenteDatos.destroy();
  if (otras > 0) throw new Error(`Hay ${otras} conexiones abiertas a "${base}": detenga la API y el worker`);

  const tablas = await herramientas.revisar(archivo);
  console.log(`Restaurando ${tablas} tablas en "${base}"…`);
  await herramientas.restaurar(archivo, base, true);

  // El respaldo usado queda CORRECTO y se borra la caché, que se acordaría de datos que ya no están.
  await fuenteDatos.initialize();
  await new RespaldosServicio()
    .marcarRestaurado(basename(archivo))
    .catch((error: Error) => console.warn(`No se pudo marcar el respaldo como CORRECTO: ${error.message}`));
  await fuenteDatos.destroy();
  await Promise.race([conectarRedis(), new Promise((listo) => setTimeout(listo, 3000))]);
  if (redis.isReady) {
    const borradas = await vaciarCache();
    console.log(`Caché de Redis borrada (${borradas} claves).`);
  } else {
    console.warn('Redis no responde: la caché de productos vence sola en 5 minutos.');
  }
  if (redis.isOpen) redis.destroy();
  console.log('Respaldo restaurado. Ya puede iniciar la API y el worker.');
}

restaurar().catch((error: Error) => {
  console.error(`No se pudo restaurar: ${error.message}`);
  process.exit(1);
});
