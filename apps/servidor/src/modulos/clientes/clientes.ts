/**
 * Módulo clientes: registro opcional para recibir promociones. Regla: solo se guarda correo y/o
 * teléfono con su consentimiento; la venta no guarda al cliente, así que no hay historial de compras.
 * Las entidades están en clientes.tablas.ts.
 */
import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { IsNull, QueryFailedError, type EntityManager } from 'typeorm';
import {
  esquemaBusquedaCliente,
  esquemaCliente,
  esquemaClienteNuevo,
  esquemaId,
  type BusquedaCliente,
  type Cliente,
  type ClienteNuevo,
} from '@pos/compartido';
import { documentar } from '../../comun/documentar';
import { Conflicto, NoEncontrado, ReglaDeNegocio } from '../../comun/errores';
import { responder } from '../../comun/respuesta';
import { autenticar, autorizar } from '../../comun/seguridad';
import { sesionDe } from '../../comun/sesion';
import { datos, validar } from '../../comun/validar';
import { fuenteDatos } from '../../infraestructura/base-datos/fuente';
import { conTransaccion } from '../../infraestructura/base-datos/transaccion';
import { BitacoraServicio } from '../bitacora/bitacora';
import { NotificacionesServicio } from '../notificaciones/notificaciones';
import { ClienteEntidad, ConsentimientoEntidad } from './clientes.tablas';

/** Cliente con su estado de suscripción. */
export interface DetalleCliente {
  cliente: ClienteEntidad;
  suscrito: boolean;
}

/** Lo que regresa registrar(): qué pasó con el cliente. */
export interface ResultadoRegistro extends DetalleCliente {
  resultado: 'NUEVO' | 'YA_SUSCRITO' | 'RENOVADO';
}

/** Contacto que el cliente da en el bot: su correo o su teléfono. */
export type ContactoBot = { correo: string; telefono?: undefined } | { telefono: string; correo?: undefined };

// --- Reglas ---

export class ClientesServicio {
  private clientes = fuenteDatos.getRepository(ClienteEntidad);
  private consentimientos = fuenteDatos.getRepository(ConsentimientoEntidad);
  private notificaciones = new NotificacionesServicio();
  private bitacora = new BitacoraServicio();

  /**
   * Registro en la caja. Si ya tiene consentimiento vigente, solo se avisa; si es nuevo o se había dado
   * de baja, tiene que aceptar el aviso, y si no acepta no se guarda nada.
   */
  async registrar(datos: ClienteNuevo, usuarioId: string): Promise<ResultadoRegistro> {
    const existente = await this.porContactos(datos.correo, datos.telefono);
    if (existente && (await this.suscrito(existente.id))) {
      return { cliente: existente, suscrito: true, resultado: 'YA_SUSCRITO' };
    }
    if (!datos.aceptaAviso) {
      throw new ReglaDeNegocio('Sin aceptar el aviso de privacidad no se guarda ningún dato');
    }

    const cliente =
      existente ??
      this.clientes.create({
        id: randomUUID(),
        correo: datos.correo ?? null,
        telefono: datos.telefono ?? null,
        telegramChatId: null,
        creadoEn: new Date(),
      });
    // Si regresa con un dato que antes no había dado, se completa.
    cliente.correo = datos.correo ?? cliente.correo;
    cliente.telefono = datos.telefono ?? cliente.telefono;

    try {
      await conTransaccion(async (manager) => {
        await manager.save(ClienteEntidad, cliente);
        await this.aceptar(manager, cliente.id, 'CAJA');
        await this.bitacora.registrar(
          {
            usuarioId,
            accion: existente ? 'CLIENTE_RENOVADO' : 'CLIENTE_REGISTRADO',
            entidad: 'cliente',
            entidadId: cliente.id,
          },
          manager,
        );
      });
    } catch (error) {
      // Dos altas al mismo tiempo con el mismo correo o teléfono: los índices únicos dejan pasar solo una.
      if (error instanceof QueryFailedError && (error.driverError as { code?: string }).code === '23505') {
        throw new Conflicto('Ese correo o teléfono acaba de registrarse; búsquelo de nuevo');
      }
      throw error;
    }
    return { cliente, suscrito: true, resultado: existente ? 'RENOVADO' : 'NUEVO' };
  }

  /** Búsqueda por correo o teléfono; da igual cómo esté escrito. */
  async buscar(contacto: string): Promise<DetalleCliente> {
    const esCorreo = contacto.includes('@');
    const cliente = await this.clientes.findOneBy(
      esCorreo ? { correo: contacto.toLowerCase() } : { telefono: contacto.replace(/\D/g, '') },
    );
    if (!cliente) throw new NoEncontrado('No hay un cliente con ese correo o teléfono');
    return { cliente, suscrito: await this.suscrito(cliente.id) };
  }

  /** Baja: retira el consentimiento y cancela lo que tuviera pendiente de envío. */
  async darDeBaja(id: string, usuarioId: string | null): Promise<DetalleCliente> {
    const cliente = await this.clientes.findOneBy({ id });
    if (!cliente) throw new NoEncontrado('El cliente no existe');
    if (!(await this.suscrito(id))) throw new Conflicto('El cliente ya se dio de baja');

    await conTransaccion(async (manager) => {
      await manager.update(
        ConsentimientoEntidad,
        { clienteId: id, revocadoEn: IsNull() },
        { revocadoEn: new Date() },
      );
      await this.notificaciones.cancelarDeCliente(manager, id);
      await this.bitacora.registrar(
        { usuarioId, accion: 'CLIENTE_BAJA', entidad: 'cliente', entidadId: id },
        manager,
      );
    });
    return { cliente, suscrito: false };
  }

  /**
   * Vinculación desde el bot. El cliente ya aceptó el aviso ahí mismo. Si su contacto ya estaba
   * registrado se le liga el chat; si no, se registra. Si se había dado de baja, queda un
   * consentimiento nuevo.
   */
  async vincularTelegram(contacto: ContactoBot, chatId: string): Promise<ResultadoRegistro> {
    const existente = await this.porContactos(contacto.correo, contacto.telefono);
    const suscrito = existente ? await this.suscrito(existente.id) : false;
    const cliente =
      existente ??
      this.clientes.create({
        id: randomUUID(),
        correo: contacto.correo ?? null,
        telefono: contacto.telefono ?? null,
        telegramChatId: null,
        creadoEn: new Date(),
      });
    cliente.telegramChatId = chatId;

    try {
      await conTransaccion(async (manager) => {
        // Un chat es de un solo cliente: si estaba ligado a otro contacto, se le quita.
        await manager
          .createQueryBuilder()
          .update(ClienteEntidad)
          .set({ telegramChatId: null })
          .where('telegram_chat_id = :chatId AND id <> :id', { chatId, id: cliente.id })
          .execute();
        await manager.save(ClienteEntidad, cliente);
        if (!suscrito) await this.aceptar(manager, cliente.id, 'TELEGRAM');
        await this.bitacora.registrar(
          {
            usuarioId: null,
            accion: existente ? 'CLIENTE_TELEGRAM_VINCULADO' : 'CLIENTE_REGISTRADO',
            entidad: 'cliente',
            entidadId: cliente.id,
          },
          manager,
        );
      });
    } catch (error) {
      if (error instanceof QueryFailedError && (error.driverError as { code?: string }).code === '23505') {
        throw new Conflicto('Ese correo o teléfono acaba de registrarse; inténtelo de nuevo');
      }
      throw error;
    }
    const resultado = !existente ? 'NUEVO' : suscrito ? 'YA_SUSCRITO' : 'RENOVADO';
    return { cliente, suscrito: true, resultado };
  }

  /** Cliente ligado a un chat del bot, con su estado de suscripción. */
  async porChat(chatId: string): Promise<DetalleCliente | null> {
    const cliente = await this.clientes.findOneBy({ telegramChatId: chatId });
    return cliente ? { cliente, suscrito: await this.suscrito(cliente.id) } : null;
  }

  /** Busca por correo y teléfono; si son de clientes distintos, no se pueden revolver. */
  private async porContactos(correo?: string, telefono?: string): Promise<ClienteEntidad | null> {
    const porCorreo = correo ? await this.clientes.findOneBy({ correo }) : null;
    const porTelefono = telefono ? await this.clientes.findOneBy({ telefono }) : null;
    if (porCorreo && porTelefono && porCorreo.id !== porTelefono.id) {
      throw new Conflicto('El correo y el teléfono son de clientes distintos');
    }
    return porCorreo ?? porTelefono;
  }

  private suscrito(clienteId: string): Promise<boolean> {
    return this.consentimientos.existsBy({ clienteId, revocadoEn: IsNull() });
  }

  private async aceptar(
    manager: EntityManager,
    clienteId: string,
    origen: ConsentimientoEntidad['origen'],
  ): Promise<void> {
    await manager.insert(ConsentimientoEntidad, {
      id: randomUUID(),
      clienteId,
      origen,
      aceptadoEn: new Date(),
      revocadoEn: null,
    });
  }
}

/** Cliente en el formato de la respuesta. */
function aCliente({ cliente: c, suscrito }: DetalleCliente): Cliente {
  return {
    id: c.id,
    correo: c.correo,
    telefono: c.telefono,
    telegramVinculado: c.telegramChatId !== null,
    suscrito,
    creadoEn: c.creadoEn.toISOString(),
  };
}

// --- Rutas ---
// Dueño y Empleado pueden registrar, buscar y dar de baja.

export function rutasClientes(): Router {
  const router = Router();
  const servicio = new ClientesServicio();

  // GET /clientes?contacto=ana@correo.mx
  router.get(
    '/clientes',
    autenticar,
    autorizar('cliente:registrar'),
    validar({ query: esquemaBusquedaCliente }),
    async (req, res) => {
      const { contacto } = datos<BusquedaCliente>(req, 'query');
      responder(res, aCliente(await servicio.buscar(contacto)), 'Cliente encontrado');
    },
  );

  // POST /clientes  { correo?, telefono?, aceptaAviso }: 201 si es nuevo, 200 si ya existía.
  router.post(
    '/clientes',
    autenticar,
    autorizar('cliente:registrar'),
    validar({ body: esquemaClienteNuevo }),
    async (req, res) => {
      const detalle = await servicio.registrar(datos<ClienteNuevo>(req, 'body'), sesionDe(req).usuarioId);
      if (detalle.resultado === 'NUEVO') {
        responder(res, aCliente(detalle), 'Cliente registrado', 201);
      } else {
        const mensaje =
          detalle.resultado === 'YA_SUSCRITO' ? 'El cliente ya está suscrito' : 'Suscripción renovada';
        responder(res, aCliente(detalle), mensaje);
      }
    },
  );

  // POST /clientes/:id/baja
  router.post(
    '/clientes/:id/baja',
    autenticar,
    autorizar('cliente:baja'),
    validar({ params: esquemaId }),
    async (req, res) => {
      const { id } = datos<{ id: string }>(req, 'params');
      responder(res, aCliente(await servicio.darDeBaja(id, sesionDe(req).usuarioId)), 'Cliente dado de baja');
    },
  );

  return router;
}

// --- Swagger ---

export function documentarClientes(registro: OpenAPIRegistry): void {
  const etiqueta = 'Clientes';
  documentar(registro, [
    {
      metodo: 'get',
      ruta: '/clientes',
      resumen: 'Buscar un cliente por correo o teléfono',
      etiqueta,
      permiso: 'cliente:registrar',
      query: esquemaBusquedaCliente,
      respuesta: esquemaCliente,
      errores: [404],
    },
    {
      metodo: 'post',
      ruta: '/clientes',
      resumen:
        'Registrar un cliente con su aceptación del aviso de privacidad; si ya existe, 200 con su estado',
      etiqueta,
      permiso: 'cliente:registrar',
      body: esquemaClienteNuevo,
      respuesta: esquemaCliente,
      estado: 201,
      errores: [409, 422],
    },
    {
      metodo: 'post',
      ruta: '/clientes/:id/baja',
      resumen: 'Dar de baja a un cliente: retira su consentimiento',
      etiqueta,
      permiso: 'cliente:baja',
      params: esquemaId,
      respuesta: esquemaCliente,
      errores: [404, 409],
    },
  ]);
}
