/**
 * Carga productos y lotes de ejemplo en la base de desarrollo (npm run datos:ejemplo). Si ya están,
 * no se repiten. La lista está en modulos/inventario/datos-ejemplo.ts.
 */

// El .env se carga antes que nada, porque la conexión lee sus variables al crearse.
import { config as cargarEnv } from 'dotenv';
cargarEnv({ path: ['.env', '../../.env'], quiet: true });

import { fuenteDatos } from './infraestructura/base-datos/fuente';
import { cargarDatosEjemplo } from './modulos/inventario/datos-ejemplo';

async function main(): Promise<void> {
  await fuenteDatos.initialize();
  try {
    await fuenteDatos.runMigrations(); // por si las tablas todavía no existen
    const agregados = await cargarDatosEjemplo();
    console.log(
      agregados.length
        ? `Productos de ejemplo agregados: ${agregados.join(', ')}`
        : 'Los productos de ejemplo ya existían; no se agregó nada',
    );
  } finally {
    await fuenteDatos.destroy();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
