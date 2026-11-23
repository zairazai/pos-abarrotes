/**
 * Configuración del servidor. Todo se lee de las variables de entorno (el archivo .env, que no se
 * sube a git); si alguna no viene, se usa el valor por defecto.
 */
import { randomBytes } from 'node:crypto';

export interface Configuracion {
  puerto: number;
  host: string; // 127.0.0.1: solo la propia PC puede conectarse
  origenesPermitidos: string[]; // lista blanca de CORS
  jwtSecreto: string; // clave para firmar los tokens
  bcryptCosto: number; // qué tan pesado es calcular el hash del PIN (10 a 12)
  pinInicial: string; // PIN temporal del Dueño en el primer arranque
  redisUrl: string; // Redis 7: caché, colas y contadores
  horaRevision: string; // "HH:MM" de la revisión diaria de caducidades
  smtp: { host: string; puerto: number; usuario: string; clave: string; remitente: string }; // sin host, se simula
  telegramToken: string; // sin token, Telegram se simula y el bot no arranca
  respaldos: { carpeta: string; pgDump: string; pgRestore: string }; // pg_dump al cerrar caja
  reportesCarpeta: string; // reportes exportados a PDF y Excel
  duenoCorreo: string; // a dónde le llegan los avisos al Dueño; su Telegram se vincula con el bot
}

function leerConfiguracion(env: NodeJS.ProcessEnv = process.env): Configuracion {
  const puerto = Number(env.PUERTO ?? 8080);
  return {
    puerto,
    host: env.HOST ?? '127.0.0.1',
    // Se aceptan varios orígenes separados por coma.
    origenesPermitidos: (env.ORIGENES_PERMITIDOS ?? `http://localhost:${puerto}`)
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
    jwtSecreto: env.JWT_SECRETO ?? secretoTemporal(),
    bcryptCosto: Number(env.BCRYPT_COSTO ?? 10),
    pinInicial: env.PIN_INICIAL ?? '0000',
    redisUrl: env.REDIS_URL ?? 'redis://127.0.0.1:6379',
    horaRevision: horaValida(env.HORA_REVISION),
    smtp: {
      host: env.SMTP_HOST ?? '',
      puerto: Number(env.SMTP_PUERTO ?? 587),
      usuario: env.SMTP_USUARIO ?? '',
      clave: env.SMTP_CLAVE ?? '',
      remitente: env.SMTP_REMITENTE ?? 'pos@tienda.local',
    },
    telegramToken: env.TELEGRAM_TOKEN ?? '',
    respaldos: {
      carpeta: env.RESPALDOS_DIR ?? 'C:\\POS\\respaldos',
      pgDump: env.RESPALDO_PG_DUMP ?? 'pg_dump',
      pgRestore: env.RESPALDO_PG_RESTORE ?? 'pg_restore',
    },
    reportesCarpeta: env.REPORTES_DIR ?? 'C:\\POS\\reportes',
    duenoCorreo: env.DUENO_CORREO ?? 'dueno@tienda.local',
  };
}

/** Hora de la revisión de caducidades; si no viene o no es "HH:MM", se queda en 06:00. */
function horaValida(hora: string | undefined): string {
  if (hora === undefined) return '06:00';
  if (/^([01]\d|2[0-3]):[0-5]\d$/.test(hora)) return hora;
  console.warn(`HORA_REVISION="${hora}" no es una hora HH:MM; se usa 06:00.`);
  return '06:00';
}

/**
 * Secreto al azar por si el .env no trae JWT_SECRETO. Sirve para desarrollar, pero cambia cada vez
 * que se reinicia y las sesiones abiertas dejan de servir.
 */
function secretoTemporal(): string {
  console.warn('JWT_SECRETO no está definido; se usa un secreto temporal.');
  return randomBytes(48).toString('base64url');
}

/** La configuración que usa todo el programa; se lee una sola vez, al arrancar. */
export const configuracion = leerConfiguracion();
