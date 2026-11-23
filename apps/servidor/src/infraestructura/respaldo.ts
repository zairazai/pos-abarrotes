/**
 * pg_dump y pg_restore, las herramientas oficiales de PostgreSQL para respaldar y restaurar. El
 * comando sale del .env: en desarrollo se usan las del contenedor (docker exec) y, si el cliente está
 * instalado, basta con "pg_dump". El respaldo va en el formato comprimido de PostgreSQL (-Fc).
 */
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import type { PostgresConnectionOptions } from 'typeorm/driver/postgres/PostgresConnectionOptions';
import { configuracion } from '../config';
import { fuenteDatos } from './base-datos/fuente';

/** Separa "docker exec -i contenedor pg_dump" en programa y argumentos. */
function partes(comando: string): [string, string[]] {
  const [programa, ...argumentos] = comando.trim().split(/\s+/);
  return [programa!, argumentos];
}

/** Usuario y contraseña de la conexión; el host y el puerto solo sirven sin docker exec. */
function conexion() {
  const o = fuenteDatos.options as PostgresConnectionOptions;
  const env = {
    ...process.env,
    PGHOST: o.host,
    PGPORT: String(o.port),
    PGPASSWORD: typeof o.password === 'string' ? o.password : '',
  };
  return { usuario: o.username!, base: String(o.database), env };
}

/**
 * Corre el comando con la entrada y salida indicadas. Si termina con error, rechaza con lo que
 * escribió en la consola, que es lo que se guarda como motivo.
 */
function ejecutar(
  comando: string,
  argumentos: string[],
  entrada?: NodeJS.ReadableStream,
  salida?: NodeJS.WritableStream,
): Promise<string> {
  const [programa, base] = partes(comando);
  const { env } = conexion();
  return new Promise((resolver, rechazar) => {
    const proceso = spawn(programa, [...base, ...argumentos], { env, windowsHide: true });
    let texto = '';
    let errores = '';
    proceso.stdout.on('data', (d: Buffer) => {
      if (salida) salida.write(d);
      else texto += d.toString();
    });
    proceso.stderr.on('data', (d: Buffer) => (errores += d.toString()));
    proceso.on('error', (error) => rechazar(new Error(`No se pudo ejecutar ${programa}: ${error.message}`)));
    proceso.on('close', (codigo) => {
      if (codigo === 0) resolver(texto);
      else rechazar(new Error(errores.trim() || `${programa} terminó con el código ${codigo}`));
    });
    if (entrada) entrada.pipe(proceso.stdin);
    else proceso.stdin.end();
  });
}

export const herramientas = {
  /** Dice si el comando de pg_dump del .env responde. */
  async disponible(): Promise<boolean> {
    return ejecutar(configuracion.respaldos.pgDump, ['--version']).then(
      () => true,
      () => false,
    );
  },

  /** Vuelca toda la base en el archivo. */
  async volcar(archivo: string): Promise<void> {
    const { usuario, base } = conexion();
    const destino = createWriteStream(archivo);
    try {
      await ejecutar(
        configuracion.respaldos.pgDump,
        ['--format=custom', '-U', usuario, '-d', base],
        undefined,
        destino,
      );
    } finally {
      await new Promise((listo) => destino.end(listo));
    }
  },

  /** Lee el índice del respaldo y cuenta sus tablas; si no se puede leer, el archivo no sirve. */
  async revisar(archivo: string): Promise<number> {
    const indice = await ejecutar(configuracion.respaldos.pgRestore, ['--list'], createReadStream(archivo));
    return indice.split('\n').filter((linea) => / TABLE DATA /.test(linea)).length;
  },

  /**
   * Restaura el respaldo en la base indicada. Con `limpiar`, primero borra lo que haya. Todo va en una
   * sola transacción: si algo falla, la base se queda como estaba.
   */
  async restaurar(archivo: string, base: string, limpiar: boolean): Promise<void> {
    const { usuario } = conexion();
    const opciones = ['--no-owner', '--exit-on-error', '--single-transaction', '-U', usuario, '-d', base];
    if (limpiar) opciones.push('--clean', '--if-exists');
    await ejecutar(configuracion.respaldos.pgRestore, opciones, createReadStream(archivo));
  },
};
