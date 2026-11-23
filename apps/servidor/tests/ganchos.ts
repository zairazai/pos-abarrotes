// Ganchos globales de Mocha: conectan con la base de pruebas y con Redis al inicio, fijan la hora de
// cada prueba con un reloj falso de Sinon y cierran la conexión al final.
import sinon from 'sinon';
import { fuenteDatos } from '../src/infraestructura/base-datos/fuente';
import { cerrarConexionesDeColas } from '../src/infraestructura/colas';
import { conectarRedis, redis } from '../src/infraestructura/redis';
import { cerrarColasDeEnvio } from '../src/modulos/notificaciones/notificaciones';
import { cerrarColaDeReportes } from '../src/modulos/reportes/reportes';
import { cerrarColaDeRespaldos } from '../src/modulos/respaldos/respaldos';

/** Hora fija con la que empieza cada prueba: 17 de octubre de 2026, 08:00 en Mazatlán. */
export const AHORA = new Date('2026-10-17T15:00:00.000Z');

let reloj: sinon.SinonFakeTimers | null = null;

/** Adelanta el reloj falso, por ejemplo para que venza un token o termine un bloqueo. */
export function adelantar(minutos: number): void {
  reloj!.setSystemTime(Date.now() + minutos * 60_000);
}

/** Pone el reloj falso en un instante exacto, por ejemplo para registrar algo en otro día. */
export function fijarHora(instante: string | Date): void {
  reloj!.setSystemTime(new Date(instante));
}

export const mochaHooks = {
  async beforeAll() {
    try {
      await fuenteDatos.initialize();
    } catch (error) {
      throw new Error(
        `No se pudo conectar a PostgreSQL. Levante la base con "npm run bd:levantar". (${(error as Error).message})`,
      );
    }
    await fuenteDatos.runMigrations();

    // Si Redis no contesta en 3 segundos, se avisa en lugar de esperar hasta el límite de Mocha.
    await Promise.race([conectarRedis(), new Promise((listo) => setTimeout(listo, 3000))]);
    if (!redis.isReady) throw new Error('No se pudo conectar a Redis. Levántelo con "npm run bd:levantar".');
  },
  beforeEach() {
    // Solo se falsea la fecha; los temporizadores siguen siendo reales para no detener a PostgreSQL.
    reloj = sinon.useFakeTimers({ now: AHORA, toFake: ['Date'] });
  },
  afterEach() {
    reloj?.restore();
    reloj = null;
  },
  async afterAll() {
    await cerrarColasDeEnvio();
    await cerrarColaDeRespaldos();
    await cerrarColaDeReportes();
    if (fuenteDatos.isInitialized) await fuenteDatos.destroy();
    if (redis.isOpen) redis.destroy();
    cerrarConexionesDeColas();
  },
};
