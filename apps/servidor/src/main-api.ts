/**
 * Arranque de la API (npm run dev / npm start): lee el .env, se conecta a PostgreSQL y a Redis,
 * aplica las migraciones pendientes y pone a escuchar la aplicación con Socket.io. Con Ctrl+C o con
 * la señal de Docker, se apaga en orden.
 */

// El .env se carga antes que nada, porque config.ts y la conexión leen sus variables al importarse.
// Se busca en esta carpeta y, si no está, en la raíz del proyecto.
import { config as cargarEnv } from 'dotenv';
cargarEnv({ path: ['.env', '../../.env'], quiet: true });

import { crearApp, VERSION } from './app';
import { cerrarTiempoReal, iniciarTiempoReal } from './comun/tiempo-real';
import { configuracion } from './config';
import { fuenteDatos } from './infraestructura/base-datos/fuente';
import { cerrarConexionesDeColas } from './infraestructura/colas';
import { conectarRedis, redis } from './infraestructura/redis';
import { CatalogoServicio } from './modulos/catalogo/catalogo';
import { cerrarColasDeEnvio } from './modulos/notificaciones/notificaciones';

async function iniciar(): Promise<void> {
  await fuenteDatos.initialize();

  // La API aplica las migraciones; en Docker Compose el worker espera a que la API esté sana.
  const aplicadas = await fuenteDatos.runMigrations();
  if (aplicadas.length) console.log(`Migraciones aplicadas: ${aplicadas.map((m) => m.name).join(', ')}`);

  // Cada vez que Redis se conecta, se precarga el catálogo (warm-up) para que las búsquedas vuelen.
  redis.on('ready', () => {
    new CatalogoServicio().precargarCache().then(
      (cuantos) => console.log(`Caché del catálogo precargada con ${cuantos} productos`),
      (error: Error) => console.warn(`No se pudo precargar la caché: ${error.message}`),
    );
  });
  // Sin esperar: si Redis está apagado, la API arranca igual y se conecta cuando Redis vuelva.
  void conectarRedis();

  const app = crearApp();
  const servidor = app.listen(configuracion.puerto, configuracion.host, () => {
    console.log(
      `API del POS ${VERSION} en http://localhost:${configuracion.puerto} (documentación en /api-docs)`,
    );
  });
  // Socket.io usa el mismo puerto que la API.
  iniciarTiempoReal(servidor);

  // Apagado en orden: primero Socket.io y el servidor HTTP (se dejan terminar las peticiones en curso)
  // y después PostgreSQL y Redis. Si en 10 segundos no acabó, se fuerza la salida.
  const cerrar = (senal: string) => {
    console.log(`Señal ${senal} recibida; cerrando la API…`);
    Promise.all([cerrarTiempoReal(), cerrarColasDeEnvio()]).finally(() => {
      cerrarConexionesDeColas();
      redis.destroy();
      fuenteDatos.destroy().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => cerrar('SIGTERM')); // Docker al detener el contenedor
  process.on('SIGINT', () => cerrar('SIGINT')); // Ctrl+C en la terminal
}

iniciar().catch((error: Error) => {
  // Lo más común: PostgreSQL está apagado o los datos de conexión del .env están mal.
  console.error(`No se pudo iniciar la API: ${error.message}`);
  process.exit(1);
});
