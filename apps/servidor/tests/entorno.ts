// Variables de entorno de las pruebas. Mocha carga este archivo antes que todos (ver .mocharc.json),
// para que la configuración y la conexión las lean al crearse.
// Primero se carga el .env (como en main-api.ts) para tomar el puerto y los datos de conexión de cada PC.
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config as cargarEnv } from 'dotenv';
cargarEnv({ path: ['.env', '../../.env'], quiet: true });

process.env.DB_NOMBRE = process.env.DB_NOMBRE_PRUEBAS ?? 'pos_pruebas';
// Las pruebas usan la base 1 de Redis para no revolverse con la 0 de desarrollo.
process.env.REDIS_URL = process.env.REDIS_URL_PRUEBAS ?? 'redis://127.0.0.1:6379/1';
process.env.JWT_SECRETO = 'secreto-de-pruebas-con-longitud-suficiente-0123456789';
process.env.BCRYPT_COSTO = '4';
process.env.PIN_INICIAL = '0000';
// Los respaldos de las pruebas van a una carpeta temporal, nunca a la de la tienda.
process.env.RESPALDOS_DIR = join(tmpdir(), 'pos-respaldos-pruebas');
process.env.REPORTES_DIR = join(tmpdir(), 'pos-reportes-pruebas');
