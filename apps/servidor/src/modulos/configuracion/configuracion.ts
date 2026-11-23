/**
 * Módulo configuración: los datos de la tienda. Regla: solo el Dueño los cambia. Ventas los usa para
 * el ticket. Aquí también se guarda el chat de Telegram del Dueño para sus avisos.
 * La entidad está en configuracion.tablas.ts.
 */
import { randomInt } from 'node:crypto';
import { Router } from 'express';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import {
  esquemaCodigoTelegram,
  esquemaConfiguracion,
  esquemaConfiguracionModificada,
  type CodigoTelegram,
  type ConfiguracionModificada,
  type ConfiguracionTienda,
} from '@pos/compartido';
import { documentar } from '../../comun/documentar';
import { ServicioNoDisponible } from '../../comun/errores';
import { responder } from '../../comun/respuesta';
import { autenticar, autorizar } from '../../comun/seguridad';
import { sesionDe } from '../../comun/sesion';
import { datos, validar } from '../../comun/validar';
import { fuenteDatos } from '../../infraestructura/base-datos/fuente';
import { conTransaccion } from '../../infraestructura/base-datos/transaccion';
import { claveRedis, redis } from '../../infraestructura/redis';
import { BitacoraServicio } from '../bitacora/bitacora';
import { ConfiguracionEntidad } from './configuracion.tablas';

/** Datos de la tienda que salen impresos en el ticket. */
export interface DatosTienda {
  nombre: string;
  direccion: string;
  telefono: string;
  politicaDevolucion: string;
  enlaceBot: string;
}

/** Configuración en el formato de la respuesta (fecha ISO). */
function aConfiguracion(c: ConfiguracionEntidad): ConfiguracionTienda {
  return {
    nombre: c.nombre,
    direccion: c.direccion,
    telefono: c.telefono,
    politicaDevolucion: c.politicaDevolucion,
    enlaceBot: c.enlaceBot,
    telegramDuenoVinculado: c.telegramDueno !== null,
    actualizadoEn: c.actualizadoEn.toISOString(),
  };
}

/** El código para vincular al Dueño dura 10 minutos y sirve una sola vez. */
const MINUTOS_CODIGO = 10;
const claveCodigo = (codigo: string) => claveRedis(`telegram:codigo:${codigo}`);

// --- Reglas ---

export class ConfiguracionServicio {
  private configuracion = fuenteDatos.getRepository(ConfiguracionEntidad);
  private bitacora = new BitacoraServicio();

  /** Lee la única fila (id = 1); si no existiera, findOneByOrFail lanza el error. */
  async consultar(): Promise<ConfiguracionEntidad> {
    return this.configuracion.findOneByOrFail({ id: 1 });
  }

  /** Actualiza los datos y los apunta en la bitácora, en la misma transacción. */
  async modificar(datos: ConfiguracionModificada, usuarioId: string): Promise<ConfiguracionEntidad> {
    const configuracion = await this.consultar();
    const antes = aConfiguracion(configuracion);

    Object.assign(configuracion, datos, { actualizadoEn: new Date(), actualizadoPor: usuarioId });

    return conTransaccion(async (manager) => {
      await manager.save(configuracion);
      await this.bitacora.registrar(
        {
          usuarioId,
          accion: 'CONFIGURACION_MODIFICADA',
          entidad: 'configuracion_tienda',
          antes,
          despues: aConfiguracion(configuracion),
        },
        manager,
      );
      return configuracion;
    });
  }

  /** Para ventas: solo lo que se imprime en el ticket. */
  async datosTienda(): Promise<DatosTienda> {
    const { nombre, direccion, telefono, politicaDevolucion, enlaceBot } = await this.consultar();
    return { nombre, direccion, telefono, politicaDevolucion, enlaceBot };
  }

  /** Chat de Telegram del Dueño; null mientras no se vincule. */
  async chatDueno(): Promise<string | null> {
    return (await this.consultar()).telegramDueno;
  }

  /**
   * Código de 6 dígitos que el Dueño le manda al bot con /dueno. Así no tiene que escribir su PIN en
   * Telegram ni andar editando el .env.
   */
  async codigoTelegram(usuarioId: string): Promise<CodigoTelegram> {
    const codigo = String(randomInt(0, 1_000_000)).padStart(6, '0');
    try {
      await redis.set(claveCodigo(codigo), usuarioId, { EX: MINUTOS_CODIGO * 60 });
    } catch {
      throw new ServicioNoDisponible('Redis no responde; intente generar el código en un momento');
    }
    const venceEn = new Date(Date.now() + MINUTOS_CODIGO * 60_000).toISOString();
    return { codigo, venceEn };
  }

  /** Lo usa el bot: si el código sirve, ese chat empieza a recibir los avisos del Dueño. */
  async vincularDueno(codigo: string, chatId: string): Promise<boolean> {
    // GETDEL lo lee y lo borra de un jalón: el código no sirve dos veces.
    const usuarioId = await redis.getDel(claveCodigo(codigo));
    if (!usuarioId) return false;

    const configuracion = await this.consultar();
    Object.assign(configuracion, {
      telegramDueno: chatId,
      actualizadoEn: new Date(),
      actualizadoPor: usuarioId,
    });
    await conTransaccion(async (manager) => {
      await manager.save(configuracion);
      await this.bitacora.registrar(
        { usuarioId, accion: 'TELEGRAM_DUENO_VINCULADO', entidad: 'configuracion_tienda' },
        manager,
      );
    });
    return true;
  }
}

// --- Rutas ---

export function rutasConfiguracion(): Router {
  const router = Router();
  const servicio = new ConfiguracionServicio();

  // GET /configuracion
  router.get('/configuracion', autenticar, autorizar('configuracion:consultar'), async (_req, res) => {
    responder(res, aConfiguracion(await servicio.consultar()), 'Configuración de la tienda');
  });

  // PUT /configuracion (solo Dueño)
  router.put(
    '/configuracion',
    autenticar,
    autorizar('configuracion:modificar'),
    validar({ body: esquemaConfiguracionModificada }),
    async (req, res) => {
      const cambios = datos<ConfiguracionModificada>(req, 'body');
      const configuracion = await servicio.modificar(cambios, sesionDe(req).usuarioId);
      responder(res, aConfiguracion(configuracion), 'Configuración guardada');
    },
  );

  // POST /configuracion/telegram-dueno (solo Dueño): código para mandar al bot con /dueno
  router.post(
    '/configuracion/telegram-dueno',
    autenticar,
    autorizar('configuracion:modificar'),
    async (req, res) => {
      const codigo = await servicio.codigoTelegram(sesionDe(req).usuarioId);
      responder(res, codigo, `Mande al bot: /dueno ${codigo.codigo}`, 201);
    },
  );

  return router;
}

// --- Swagger ---

export function documentarConfiguracion(registro: OpenAPIRegistry): void {
  const etiqueta = 'Configuración';
  documentar(registro, [
    {
      metodo: 'get',
      ruta: '/configuracion',
      resumen: 'Consultar los datos de la tienda para el ticket',
      etiqueta,
      permiso: 'configuracion:consultar',
      respuesta: esquemaConfiguracion,
    },
    {
      metodo: 'put',
      ruta: '/configuracion',
      resumen: 'Modificar los datos de la tienda',
      etiqueta,
      permiso: 'configuracion:modificar',
      body: esquemaConfiguracionModificada,
      respuesta: esquemaConfiguracion,
    },
    {
      metodo: 'post',
      ruta: '/configuracion/telegram-dueno',
      resumen: 'Generar el código para recibir los avisos del Dueño por Telegram',
      etiqueta,
      permiso: 'configuracion:modificar',
      respuesta: esquemaCodigoTelegram,
      estado: 201,
      errores: [503],
    },
  ]);
}
