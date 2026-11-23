/**
 * Módulo notificaciones: promociones a los clientes que aceptaron y avisos al Dueño. Cada envío se
 * guarda en la tabla envio y se forma en la cola de su canal; el worker lo manda con hasta 3 intentos.
 * La caja nunca espera: si Redis no responde, el envío se queda pendiente y el worker lo recoge al
 * arrancar. La entidad está en notificaciones.tablas.ts.
 */
import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import type { Queue } from 'bullmq';
import type { EntityManager } from 'typeorm';
import { z } from 'zod';
import {
  esquemaConsultaEnvios,
  esquemaEnvio,
  PIE_BAJA_CORREO,
  PIE_BAJA_TELEGRAM,
  type CanalEnvio,
  type ConsultaEnvios,
  type Envio,
} from '@pos/compartido';
import { documentar } from '../../comun/documentar';
import { paginacion, responder } from '../../comun/respuesta';
import { autenticar, autorizar } from '../../comun/seguridad';
import { datos, validar } from '../../comun/validar';
import { configuracion } from '../../config';
import { fuenteDatos } from '../../infraestructura/base-datos/fuente';
import { crearCola } from '../../infraestructura/colas';
import { mensajeria } from '../../infraestructura/mensajeria';
import { ClienteEntidad, ConsentimientoEntidad } from '../clientes/clientes.tablas';
import { ConfiguracionServicio } from '../configuracion/configuracion';
import { EnvioEntidad } from './notificaciones.tablas';

export const COLAS_ENVIO: Record<CanalEnvio, string> = { CORREO: 'correo', TELEGRAM: 'telegram' };

// Cada proceso abre las colas la primera vez que las necesita.
const colas = new Map<CanalEnvio, Queue>();

function colaDe(canal: CanalEnvio): Queue {
  let cola = colas.get(canal);
  if (!cola) {
    cola = crearCola(COLAS_ENVIO[canal]);
    colas.set(canal, cola);
  }
  return cola;
}

/** Forma el envío en su cola; el id evita que el mismo envío entre dos veces. */
export async function publicarEnvio(canal: CanalEnvio, id: string): Promise<void> {
  await colaDe(canal).add('enviar', { envioId: id }, { jobId: id });
}

export async function cerrarColasDeEnvio(): Promise<void> {
  await Promise.all([...colas.values()].map((c) => c.close()));
  colas.clear();
}

// --- Reglas ---

type EnvioNuevo = Pick<EnvioEntidad, 'canal' | 'tipo' | 'destinatario' | 'clienteId' | 'asunto' | 'mensaje'>;

export class NotificacionesServicio {
  private envios = fuenteDatos.getRepository(EnvioEntidad);

  /** Regla: un envío por cliente y canal, y solo si sigue aceptando avisos. */
  async difundirPromocion(asunto: string, mensaje: string): Promise<void> {
    const clientes = await this.envios.manager
      .createQueryBuilder(ClienteEntidad, 'c')
      .innerJoin(ConsentimientoEntidad, 'k', 'k.cliente_id = c.id AND k.revocado_en IS NULL')
      .getMany();
    const nuevos: EnvioNuevo[] = [];
    for (const c of clientes) {
      const base = { tipo: 'PROMOCION', clienteId: c.id, asunto } as const;
      if (c.correo) {
        nuevos.push({
          ...base,
          canal: 'CORREO',
          destinatario: c.correo,
          mensaje: `${mensaje}\n\n${PIE_BAJA_CORREO}`,
        });
      }
      if (c.telegramChatId) {
        nuevos.push({
          ...base,
          canal: 'TELEGRAM',
          destinatario: c.telegramChatId,
          mensaje: `${mensaje}\n\n${PIE_BAJA_TELEGRAM}`,
        });
      }
    }
    await this.encolar(nuevos);
  }

  /** Aviso al Dueño: por correo y, si ya ligó su chat con el bot, también por Telegram. */
  async avisarAlDueno(asunto: string, mensaje: string): Promise<void> {
    const base = { tipo: 'RESUMEN_DIA', clienteId: null, asunto, mensaje } as const;
    const nuevos: EnvioNuevo[] = [{ ...base, canal: 'CORREO', destinatario: configuracion.duenoCorreo }];
    const chat = await new ConfiguracionServicio().chatDueno();
    if (chat) nuevos.push({ ...base, canal: 'TELEGRAM', destinatario: chat });
    await this.encolar(nuevos);
  }

  /** Si un cliente se da de baja, se cancelan sus envíos pendientes. */
  async cancelarDeCliente(manager: EntityManager, clienteId: string): Promise<void> {
    await manager.update(EnvioEntidad, { clienteId, estado: 'PENDIENTE' }, { estado: 'CANCELADO' });
  }

  /** Lo corre el worker. Si falla, avienta el error para que BullMQ lo reintente. */
  async procesar(id: string, intento: number): Promise<void> {
    const envio = await this.envios.findOneBy({ id });
    if (envio?.estado !== 'PENDIENTE') return; // cancelado o ya enviado
    await this.envios.update(id, { intentos: intento });
    if (envio.canal === 'CORREO') {
      await mensajeria.correo(envio.destinatario, envio.asunto, envio.mensaje);
    } else {
      await mensajeria.telegram(envio.destinatario, envio.mensaje);
    }
    await this.envios.update(id, { estado: 'ENVIADO', error: null, enviadoEn: new Date() });
  }

  /** Se acabó sus intentos: queda como fallido, con el motivo. */
  async marcarFallido(id: string, intentos: number, error: string): Promise<void> {
    await this.envios.update(id, { estado: 'FALLIDO', intentos, error: error.slice(0, 300) });
  }

  pendientes(): Promise<EnvioEntidad[]> {
    return this.envios.findBy({ estado: 'PENDIENTE' });
  }

  /** Envíos del más nuevo al más viejo; se puede filtrar por estado. */
  async listar(consulta: ConsultaEnvios): Promise<{ envios: EnvioEntidad[]; total: number }> {
    const [envios, total] = await this.envios.findAndCount({
      where: consulta.estado ? { estado: consulta.estado } : {},
      order: { creadoEn: 'DESC' },
      skip: (consulta.page - 1) * consulta.limit,
      take: consulta.limit,
    });
    return { envios, total };
  }

  /** Guarda los envíos y los forma en las colas sin quedarse esperando a Redis. */
  private async encolar(nuevos: EnvioNuevo[]): Promise<void> {
    if (nuevos.length === 0) return;
    const filas = nuevos.map((n) =>
      this.envios.create({
        ...n,
        id: randomUUID(),
        estado: 'PENDIENTE',
        intentos: 0,
        error: null,
        creadoEn: new Date(),
        enviadoEn: null,
      }),
    );
    await this.envios.insert(filas);
    for (const f of filas) {
      publicarEnvio(f.canal, f.id).catch((error: Error) => {
        console.warn(`Envío ${f.id} sin encolar; el worker lo recuperará (${error.message})`);
      });
    }
  }
}

/** Envío en el formato de la respuesta; sin destinatario ni mensaje, para no andar enseñando contactos. */
function aEnvio(e: EnvioEntidad): Envio {
  return {
    id: e.id,
    canal: e.canal,
    tipo: e.tipo,
    asunto: e.asunto,
    estado: e.estado,
    intentos: e.intentos,
    error: e.error,
    creadoEn: e.creadoEn.toISOString(),
    enviadoEn: e.enviadoEn?.toISOString() ?? null,
  };
}

// --- Rutas ---

export function rutasNotificaciones(): Router {
  const router = Router();
  const servicio = new NotificacionesServicio();

  // GET /envios?estado=FALLIDO&page=1&limit=20 (solo el Dueño)
  router.get(
    '/envios',
    autenticar,
    autorizar('envio:consultar'),
    validar({ query: esquemaConsultaEnvios }),
    async (req, res) => {
      const consulta = datos<ConsultaEnvios>(req, 'query');
      const { envios, total } = await servicio.listar(consulta);
      const meta = paginacion(consulta.page, consulta.limit, total);
      responder(res, envios.map(aEnvio), `${total} envíos`, 200, meta);
    },
  );

  return router;
}

// --- Swagger ---

export function documentarNotificaciones(registro: OpenAPIRegistry): void {
  documentar(registro, [
    {
      metodo: 'get',
      ruta: '/envios',
      resumen: 'Consultar los envíos por correo y Telegram; los fallidos quedan registrados',
      etiqueta: 'Notificaciones',
      permiso: 'envio:consultar',
      query: esquemaConsultaEnvios,
      respuesta: z.array(esquemaEnvio),
      paginada: true,
    },
  ]);
}
