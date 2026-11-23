/**
 * Módulo bitácora: accesos y cambios al catálogo, al dinero y al inventario quedan apuntados con
 * quién, cuándo y qué cambió. Los demás módulos llaman a registrar(); el Dueño la puede consultar,
 * pero nadie la puede modificar ni borrar.
 */
import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import type { EntityManager } from 'typeorm';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import {
  esquemaConsultaBitacora,
  esquemaRegistroBitacora,
  type ConsultaBitacora,
  type RegistroBitacora,
} from '@pos/compartido';
import { documentar } from '../../comun/documentar';
import { finDelDia, inicioDelDia } from '../../comun/fechas';
import { paginacion, responder } from '../../comun/respuesta';
import { autenticar, autorizar } from '../../comun/seguridad';
import { datos, validar } from '../../comun/validar';
import { fuenteDatos } from '../../infraestructura/base-datos/fuente';
import { BitacoraEntidad } from './bitacora.tablas';

/** Evento para apuntar. Ojo: nunca debe llevar el PIN ni su hash. */
export interface EventoBitacora {
  usuarioId: string | null;
  accion: string; // por ejemplo 'PRODUCTO_REGISTRADO'
  entidad: string; // tabla afectada
  entidadId?: string | null;
  antes?: unknown;
  despues?: unknown;
}

/** Registro en el formato de la respuesta. */
function aRegistroBitacora(r: BitacoraEntidad): RegistroBitacora {
  return {
    id: r.id,
    fecha: r.fecha.toISOString(),
    usuarioId: r.usuarioId,
    accion: r.accion,
    entidad: r.entidad,
    entidadId: r.entidadId,
    antes: r.antes,
    despues: r.despues,
  };
}

// --- Reglas ---

export class BitacoraServicio {
  /**
   * Apunta un evento. Si se le pasa el manager de una transacción, el registro va dentro de ella y se
   * deshace junto con el cambio; si no, usa la conexión normal.
   */
  async registrar(evento: EventoBitacora, manager: EntityManager = fuenteDatos.manager): Promise<void> {
    await manager.insert(BitacoraEntidad, {
      id: randomUUID(),
      fecha: new Date(),
      usuarioId: evento.usuarioId,
      accion: evento.accion,
      entidad: evento.entidad,
      entidadId: evento.entidadId ?? null,
      antes: (evento.antes ?? null) as object | null,
      despues: (evento.despues ?? null) as object | null,
    });
  }

  /** Consulta, del más nuevo al más viejo, con filtros opcionales de días, usuario y acción. */
  async consultar(consulta: ConsultaBitacora): Promise<{ registros: BitacoraEntidad[]; total: number }> {
    const qb = fuenteDatos.getRepository(BitacoraEntidad).createQueryBuilder('b');

    // Los días van en hora de la tienda: desde las 00:00 hasta las 23:59.
    if (consulta.desde) qb.andWhere('b.fecha >= :desde', { desde: inicioDelDia(consulta.desde) });
    if (consulta.hasta) qb.andWhere('b.fecha <= :hasta', { hasta: finDelDia(consulta.hasta) });
    if (consulta.usuarioId) qb.andWhere('b.usuario_id = :usuarioId', { usuarioId: consulta.usuarioId });
    if (consulta.accion) qb.andWhere('b.accion = :accion', { accion: consulta.accion });

    const [registros, total] = await qb
      .orderBy('b.fecha', 'DESC')
      .skip((consulta.page - 1) * consulta.limit)
      .take(consulta.limit)
      .getManyAndCount();
    return { registros, total };
  }
}

// --- Rutas ---
// Solo lectura: no hay ninguna ruta para modificar ni borrar la bitácora.

export function rutasBitacora(): Router {
  const router = Router();
  const servicio = new BitacoraServicio();

  // GET /bitacora?desde=2026-10-01&accion=ACCESO (solo Dueño)
  router.get(
    '/bitacora',
    autenticar,
    autorizar('bitacora:consultar'),
    validar({ query: esquemaConsultaBitacora }),
    async (req, res) => {
      const consulta = datos<ConsultaBitacora>(req, 'query');
      const { registros, total } = await servicio.consultar(consulta);
      const meta = paginacion(consulta.page, consulta.limit, total);
      responder(res, registros.map(aRegistroBitacora), 'Bitácora', 200, meta);
    },
  );

  return router;
}

// --- Swagger ---

export function documentarBitacora(registro: OpenAPIRegistry): void {
  documentar(registro, [
    {
      metodo: 'get',
      ruta: '/bitacora',
      resumen: 'Consultar la bitácora con filtros',
      etiqueta: 'Bitácora',
      permiso: 'bitacora:consultar',
      query: esquemaConsultaBitacora,
      respuesta: z.array(esquemaRegistroBitacora),
      paginada: true,
    },
  ]);
}
