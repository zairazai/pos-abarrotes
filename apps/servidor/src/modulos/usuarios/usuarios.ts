/**
 * Módulo usuarios: alta, restablecer PIN y desactivar. Regla: todo eso solo lo hace el Dueño. También
 * le da al módulo de acceso la búsqueda por PIN y el cambio del PIN propio.
 */
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcrypt';
import { Router } from 'express';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import {
  esquemaCambioPin,
  esquemaId,
  esquemaUsuario,
  esquemaUsuarioNuevo,
  type Preferencias,
  type Usuario,
  type UsuarioNuevo,
} from '@pos/compartido';
import { configuracion } from '../../config';
import { documentar } from '../../comun/documentar';
import { Conflicto, NoEncontrado, ReglaDeNegocio } from '../../comun/errores';
import { responder } from '../../comun/respuesta';
import { autenticar, autorizar } from '../../comun/seguridad';
import { sesionDe } from '../../comun/sesion';
import { revocarSesiones } from '../../comun/tiempo-real';
import { datos, validar } from '../../comun/validar';
import { fuenteDatos } from '../../infraestructura/base-datos/fuente';
import { conTransaccion } from '../../infraestructura/base-datos/transaccion';
import { BitacoraServicio } from '../bitacora/bitacora';
import { UsuarioEntidad } from './usuarios.tablas';

/** Tamaño de letra con el que arranca el modo accesible. */
const LETRA_ACCESIBLE = 200;

/** Usuario en el formato de la respuesta (sin el hash del PIN). */
export function aUsuario(u: UsuarioEntidad): Usuario {
  return {
    id: u.id,
    nombre: u.nombre,
    rol: u.rol,
    modoAccesible: u.modoAccesible,
    tamanoLetra: u.tamanoLetra,
    activo: u.activo,
    debeCambiarPin: u.debeCambiarPin,
  };
}

/** Datos del usuario para la bitácora, sin PIN ni hash. */
function paraBitacora(u: UsuarioEntidad) {
  return { nombre: u.nombre, rol: u.rol, modoAccesible: u.modoAccesible, activo: u.activo };
}

// --- Reglas ---

export class UsuariosServicio {
  private usuarios = fuenteDatos.getRepository(UsuarioEntidad);
  private bitacora = new BitacoraServicio();

  /** En el primer arranque se crea el Dueño con el PIN temporal del .env, que tiene que cambiar al entrar. */
  async asegurarDuenoInicial(): Promise<void> {
    if ((await this.usuarios.count()) > 0) return;
    await this.usuarios.save(
      this.usuarios.create({
        id: randomUUID(),
        nombre: 'Dueño',
        rol: 'DUENO',
        pinHash: await bcrypt.hash(configuracion.pinInicial, configuracion.bcryptCosto),
        modoAccesible: true,
        tamanoLetra: LETRA_ACCESIBLE,
        activo: true,
        debeCambiarPin: true,
        creadoEn: new Date(),
        actualizadoEn: new Date(),
      }),
    );
  }

  async listar(): Promise<UsuarioEntidad[]> {
    return this.usuarios.find({ order: { nombre: 'ASC' } });
  }

  /** Alta de usuario. Regla: el PIN no se puede repetir. */
  async registrar(datos: UsuarioNuevo, actorId: string): Promise<UsuarioEntidad> {
    await this.validarPinLibre(datos.pin);
    const usuario = this.usuarios.create({
      id: randomUUID(),
      nombre: datos.nombre,
      rol: datos.rol,
      pinHash: await bcrypt.hash(datos.pin, configuracion.bcryptCosto),
      modoAccesible: datos.modoAccesible,
      tamanoLetra: datos.modoAccesible ? LETRA_ACCESIBLE : 100,
      activo: true,
      debeCambiarPin: false,
      creadoEn: new Date(),
      actualizadoEn: new Date(),
    });
    // Usuario y bitácora en la misma transacción.
    return conTransaccion(async (manager) => {
      await manager.save(usuario);
      await this.bitacora.registrar(
        {
          usuarioId: actorId,
          accion: 'USUARIO_REGISTRADO',
          entidad: 'usuario',
          entidadId: usuario.id,
          despues: paraBitacora(usuario),
        },
        manager,
      );
      return usuario;
    });
  }

  /** El Dueño restablece el PIN de alguien, por ejemplo si se le olvidó. */
  async restablecerPin(id: string, pin: string, actorId: string): Promise<UsuarioEntidad> {
    const usuario = await this.usuarioActivo(id);
    await this.asignarPin(usuario, pin);
    return conTransaccion(async (manager) => {
      await manager.save(usuario);
      // Se apunta que hubo cambio, nunca el PIN.
      await this.bitacora.registrar(
        { usuarioId: actorId, accion: 'USUARIO_PIN_RESTABLECIDO', entidad: 'usuario', entidadId: id },
        manager,
      );
      return usuario;
    });
  }

  /**
   * Desactivar un usuario; no se borra para no perder su historial. Regla: nadie se puede desactivar a
   * sí mismo, así siempre queda un Dueño activo.
   */
  async desactivar(id: string, actorId: string): Promise<UsuarioEntidad> {
    const usuario = await this.usuarioActivo(id);
    if (id === actorId) {
      throw new ReglaDeNegocio('No puede desactivarse a sí mismo: siempre debe existir un Dueño activo');
    }
    const antes = paraBitacora(usuario);
    usuario.activo = false;
    usuario.actualizadoEn = new Date();
    return conTransaccion(async (manager) => {
      await manager.save(usuario);
      await this.bitacora.registrar(
        {
          usuarioId: actorId,
          accion: 'USUARIO_DESACTIVADO',
          entidad: 'usuario',
          entidadId: id,
          antes,
          despues: paraBitacora(usuario),
        },
        manager,
      );
      return usuario;
    });
  }

  // Para los módulos de acceso y ventas:

  /**
   * Busca al usuario activo con ese PIN. Como solo se guarda el hash, se compara uno por uno con
   * bcrypt.compare; no pasa nada porque son pocos usuarios.
   */
  async usuarioActivoPorPin(pin: string): Promise<UsuarioEntidad | null> {
    for (const usuario of await this.usuarios.findBy({ activo: true })) {
      if (await bcrypt.compare(pin, usuario.pinHash)) return usuario;
    }
    return null;
  }

  async usuarioActivoPorId(id: string): Promise<UsuarioEntidad | null> {
    return this.usuarios.findOneBy({ id, activo: true });
  }

  /** Incluye desactivados (por ejemplo, el cajero de un ticket viejo). */
  async usuarioPorId(id: string): Promise<UsuarioEntidad | null> {
    return this.usuarios.findOneBy({ id });
  }

  /** Cambiar el PIN propio (obligatorio si se trae el temporal). */
  async cambiarMiPin(id: string, pin: string): Promise<UsuarioEntidad> {
    const usuario = await this.usuarioActivo(id);
    await this.asignarPin(usuario, pin);
    return conTransaccion(async (manager) => {
      await manager.save(usuario);
      await this.bitacora.registrar(
        { usuarioId: id, accion: 'PIN_CAMBIADO', entidad: 'usuario', entidadId: id },
        manager,
      );
      return usuario;
    });
  }

  /** Preferencias de accesibilidad del perfil. */
  async guardarPreferencias(id: string, preferencias: Preferencias): Promise<UsuarioEntidad> {
    const usuario = await this.usuarioActivo(id);
    // Solo se cambia lo que venga en la petición.
    if (preferencias.modoAccesible !== undefined) usuario.modoAccesible = preferencias.modoAccesible;
    if (preferencias.tamanoLetra !== undefined) usuario.tamanoLetra = preferencias.tamanoLetra;
    usuario.actualizadoEn = new Date();
    return this.usuarios.save(usuario);
  }

  // Revisiones de adentro

  private async usuarioActivo(id: string): Promise<UsuarioEntidad> {
    const usuario = await this.usuarioActivoPorId(id);
    if (!usuario) throw new NoEncontrado('El usuario no existe o está desactivado');
    return usuario;
  }

  /** Pone el hash del PIN nuevo y quita la marca de PIN temporal (no guarda). */
  private async asignarPin(usuario: UsuarioEntidad, pin: string): Promise<void> {
    await this.validarPinLibre(pin, usuario.id);
    usuario.pinHash = await bcrypt.hash(pin, configuracion.bcryptCosto);
    usuario.debeCambiarPin = false;
    usuario.actualizadoEn = new Date();
  }

  /**
   * Regla: dos usuarios activos no pueden tener el mismo PIN, porque con el PIN se sabe quién entra.
   * idPropio deja volver a poner el PIN propio.
   */
  private async validarPinLibre(pin: string, idPropio?: string): Promise<void> {
    const dueno = await this.usuarioActivoPorPin(pin);
    if (dueno && dueno.id !== idPropio) {
      throw new Conflicto('Ese PIN ya lo usa otro usuario activo; elija otro');
    }
  }
}

// --- Rutas (solo Dueño) ---

export function rutasUsuarios(): Router {
  const router = Router();
  const servicio = new UsuariosServicio();

  // GET /usuarios
  router.get('/usuarios', autenticar, autorizar('usuario:consultar'), async (_req, res) => {
    responder(res, (await servicio.listar()).map(aUsuario), 'Usuarios');
  });

  // POST /usuarios
  router.post(
    '/usuarios',
    autenticar,
    autorizar('usuario:registrar'),
    validar({ body: esquemaUsuarioNuevo }),
    async (req, res) => {
      const usuario = await servicio.registrar(datos<UsuarioNuevo>(req, 'body'), sesionDe(req).usuarioId);
      responder(res, aUsuario(usuario), 'Usuario registrado', 201);
    },
  );

  // PATCH /usuarios/:id/pin
  router.patch(
    '/usuarios/:id/pin',
    autenticar,
    autorizar('usuario:restablecer_pin'),
    validar({ params: esquemaId, body: esquemaCambioPin }),
    async (req, res) => {
      const { id } = datos<{ id: string }>(req, 'params');
      const { pin } = datos<{ pin: string }>(req, 'body');
      const usuario = await servicio.restablecerPin(id, pin, sesionDe(req).usuarioId);
      responder(res, aUsuario(usuario), 'PIN restablecido');
    },
  );

  // PATCH /usuarios/:id/desactivar
  router.patch(
    '/usuarios/:id/desactivar',
    autenticar,
    autorizar('usuario:desactivar'),
    validar({ params: esquemaId }),
    async (req, res) => {
      const { id } = datos<{ id: string }>(req, 'params');
      const usuario = await servicio.desactivar(id, sesionDe(req).usuarioId);
      revocarSesiones(usuario.id);
      responder(res, aUsuario(usuario), 'Usuario desactivado');
    },
  );

  return router;
}

// --- Swagger ---

export function documentarUsuarios(registro: OpenAPIRegistry): void {
  const etiqueta = 'Usuarios';
  documentar(registro, [
    {
      metodo: 'get',
      ruta: '/usuarios',
      resumen: 'Listar usuarios',
      etiqueta,
      permiso: 'usuario:consultar',
      respuesta: z.array(esquemaUsuario),
    },
    {
      metodo: 'post',
      ruta: '/usuarios',
      resumen: 'Registrar un usuario',
      etiqueta,
      permiso: 'usuario:registrar',
      body: esquemaUsuarioNuevo,
      respuesta: esquemaUsuario,
      estado: 201,
      errores: [409],
    },
    {
      metodo: 'patch',
      ruta: '/usuarios/:id/pin',
      resumen: 'Restablecer el PIN de un usuario',
      etiqueta,
      permiso: 'usuario:restablecer_pin',
      params: esquemaId,
      body: esquemaCambioPin,
      respuesta: esquemaUsuario,
      errores: [404, 409],
    },
    {
      metodo: 'patch',
      ruta: '/usuarios/:id/desactivar',
      resumen: 'Desactivar un usuario sin borrar su historial',
      etiqueta,
      permiso: 'usuario:desactivar',
      params: esquemaId,
      respuesta: esquemaUsuario,
      errores: [404, 422],
    },
  ]);
}
