/**
 * Módulo respaldos: al cerrar la caja, el worker respalda toda la base con pg_dump, revisa que el
 * archivo se pueda leer y se queda con los últimos 7. Si falla, el cierre no se deshace: el respaldo
 * queda FALLIDO con el motivo y se avisa. La entidad está en respaldos.tablas.ts y la restauración
 * en main-restaurar.ts.
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Router } from 'express';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import type { Queue } from 'bullmq';
import { z } from 'zod';
import {
  esquemaConsultaRespaldos,
  esquemaRespaldo,
  type ConsultaRespaldos,
  type Respaldo,
} from '@pos/compartido';
import { documentar } from '../../comun/documentar';
import { fechaLocal, horaLocal } from '../../comun/fechas';
import { paginacion, responder } from '../../comun/respuesta';
import { autenticar, autorizar } from '../../comun/seguridad';
import { datos, validar } from '../../comun/validar';
import { configuracion } from '../../config';
import { fuenteDatos } from '../../infraestructura/base-datos/fuente';
import { crearCola } from '../../infraestructura/colas';
import { herramientas } from '../../infraestructura/respaldo';
import { RespaldoEntidad } from './respaldos.tablas';

export const COLA_RESPALDOS = 'respaldos';
/** Cuántos archivos se guardan. */
export const RESPALDOS_CONSERVADOS = 7;

let cola: Queue | null = null;

/** Forma el respaldo en la cola; el id evita que entre dos veces. */
export async function publicarRespaldo(id: string): Promise<void> {
  cola ??= crearCola(COLA_RESPALDOS);
  // Un solo intento: si falla, se avisa y el siguiente cierre vuelve a respaldar.
  await cola.add('respaldar', { respaldoId: id }, { jobId: id, attempts: 1 });
}

export async function cerrarColaDeRespaldos(): Promise<void> {
  await cola?.close();
  cola = null;
}

/**
 * Los archivos llevan el nombre de la base, la fecha y hora de la tienda y el principio del id, por
 * ejemplo pos_2026-10-17_20-15-07_9f2c1a3b.dump. Así no se revuelven las bases ni se repiten.
 */
const prefijo = () => `${String(fuenteDatos.options.database)}_`;
const rutaDe = (archivo: string) => join(configuracion.respaldos.carpeta, archivo);

function nombreArchivo(id: string, instante: Date): string {
  const segundos = String(instante.getUTCSeconds()).padStart(2, '0');
  const hora = `${horaLocal(instante).replace(':', '-')}-${segundos}`;
  return `${prefijo()}${fechaLocal(instante)}_${hora}_${id.slice(0, 8)}.dump`;
}

// --- Reglas ---

export class RespaldosServicio {
  private respaldos = fuenteDatos.getRepository(RespaldoEntidad);

  /** Lo pide el cierre de caja: guarda la fila y la forma en la cola sin esperar al pg_dump. */
  async encolar(cajaId: string | null): Promise<RespaldoEntidad> {
    const id = randomUUID();
    const creadoEn = new Date();
    const respaldo = this.respaldos.create({
      id,
      cajaId,
      archivo: nombreArchivo(id, creadoEn),
      bytes: null,
      estado: 'PENDIENTE',
      error: null,
      creadoEn,
      terminadoEn: null,
    });
    await this.respaldos.insert(respaldo);
    publicarRespaldo(respaldo.id).catch((error: Error) => {
      console.warn(`Respaldo ${respaldo.id} sin encolar; el worker lo recuperará (${error.message})`);
    });
    return respaldo;
  }

  /**
   * Lo corre el worker: pg_dump a un archivo temporal, revisión con pg_restore --list y, si todo sale
   * bien, se le pone su nombre final y se borran los más viejos. Si falla, avienta el error.
   */
  async generar(id: string): Promise<RespaldoEntidad> {
    const respaldo = await this.respaldos.findOneByOrFail({ id });
    if (respaldo.estado !== 'PENDIENTE') return respaldo;

    const final = rutaDe(respaldo.archivo);
    const temporal = `${final}.parcial`;
    try {
      await mkdir(configuracion.respaldos.carpeta, { recursive: true });
      await herramientas.volcar(temporal);
      const tablas = await herramientas.revisar(temporal);
      if (tablas === 0) throw new Error('El respaldo no contiene tablas');
      await rename(temporal, final);
    } catch (error) {
      // No se deja un archivo a medias que parezca respaldo.
      await rm(temporal, { force: true });
      await this.respaldos.update(id, {
        estado: 'FALLIDO',
        error: (error as Error).message.slice(0, 300),
        terminadoEn: new Date(),
      });
      throw error;
    }

    const { size } = await stat(final);
    Object.assign(respaldo, { estado: 'CORRECTO', bytes: String(size), terminadoEn: new Date() });
    await this.respaldos.save(respaldo);
    await this.rotar();
    return respaldo;
  }

  /** Borra los archivos de esta base que pasen de los últimos 7. */
  async rotar(): Promise<string[]> {
    const archivos = (await readdir(configuracion.respaldos.carpeta))
      .filter((a) => a.startsWith(prefijo()) && a.endsWith('.dump'))
      .sort() // el nombre lleva fecha y hora: en orden alfabético quedan del más viejo al más nuevo
      .reverse();
    const sobrantes = archivos.slice(RESPALDOS_CONSERVADOS);
    for (const archivo of sobrantes) await rm(rutaDe(archivo), { force: true });
    return sobrantes;
  }

  /**
   * Después de restaurar: el pg_dump corre mientras la fila sigue PENDIENTE, así que dentro del archivo
   * el respaldo quedó así. Como el archivo sí sirvió, se deja CORRECTO; si no, el worker lo volvería a
   * hacer al arrancar.
   */
  async marcarRestaurado(archivo: string): Promise<void> {
    const respaldo = await this.respaldos.findOneBy({ archivo, estado: 'PENDIENTE' });
    if (!respaldo) return;
    const { size } = await stat(rutaDe(archivo));
    Object.assign(respaldo, {
      estado: 'CORRECTO',
      bytes: String(size),
      error: null,
      terminadoEn: new Date(),
    });
    await this.respaldos.save(respaldo);
  }

  pendientes(): Promise<RespaldoEntidad[]> {
    return this.respaldos.findBy({ estado: 'PENDIENTE' });
  }

  /** Respaldos del más nuevo al más viejo. */
  async listar(consulta: ConsultaRespaldos): Promise<{ respaldos: RespaldoEntidad[]; total: number }> {
    const [respaldos, total] = await this.respaldos.findAndCount({
      order: { creadoEn: 'DESC' },
      skip: (consulta.page - 1) * consulta.limit,
      take: consulta.limit,
    });
    return { respaldos, total };
  }
}

/** Respaldo en el formato de la respuesta; dice si el archivo sigue en la carpeta. */
function aRespaldo(r: RespaldoEntidad): Respaldo {
  return {
    id: r.id,
    archivo: r.archivo,
    bytes: r.bytes === null ? null : Number(r.bytes),
    estado: r.estado,
    error: r.error,
    disponible: r.estado === 'CORRECTO' && existsSync(rutaDe(r.archivo)),
    creadoEn: r.creadoEn.toISOString(),
    terminadoEn: r.terminadoEn?.toISOString() ?? null,
  };
}

// --- Rutas ---

export function rutasRespaldos(): Router {
  const router = Router();
  const servicio = new RespaldosServicio();

  // GET /respaldos?page=1&limit=20 (solo el Dueño)
  router.get(
    '/respaldos',
    autenticar,
    autorizar('respaldo:consultar'),
    validar({ query: esquemaConsultaRespaldos }),
    async (req, res) => {
      const consulta = datos<ConsultaRespaldos>(req, 'query');
      const { respaldos, total } = await servicio.listar(consulta);
      const meta = paginacion(consulta.page, consulta.limit, total);
      responder(res, respaldos.map(aRespaldo), `${total} respaldos`, 200, meta);
    },
  );

  return router;
}

// --- Swagger ---

export function documentarRespaldos(registro: OpenAPIRegistry): void {
  documentar(registro, [
    {
      metodo: 'get',
      ruta: '/respaldos',
      resumen: 'Consultar los respaldos que se hacen al cerrar la caja',
      etiqueta: 'Respaldos',
      permiso: 'respaldo:consultar',
      query: esquemaConsultaRespaldos,
      respuesta: z.array(esquemaRespaldo),
      paginada: true,
    },
  ]);
}
