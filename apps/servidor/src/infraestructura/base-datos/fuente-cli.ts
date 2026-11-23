/**
 * Conexión para los comandos de migraciones de TypeORM (migracion:ejecutar, migracion:revertir y
 * migracion:ver). El .env se carga antes de importar la conexión, que lee las variables DB_*.
 */
import { config } from 'dotenv';
config({ path: ['.env', '../../.env'], quiet: true });

import { fuenteDatos } from './fuente';

export default fuenteDatos;
