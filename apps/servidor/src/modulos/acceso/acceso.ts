/**
 * Módulo acceso: entrar con PIN, renovar, salir y el bloqueo.
 * Con el PIN correcto se entregan dos tokens: el de acceso (JWT de 15 minutos, va en cada petición)
 * y el de renovación (sirve hasta que acaba el día, para pedir otro de acceso sin el PIN).
 * Regla: cinco PIN incorrectos seguidos bloquean la caja 5 minutos.
 * Los filtros autenticar y autorizar están en comun/seguridad.ts.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Router } from 'express';
import jwt from 'jsonwebtoken';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import {
  esquemaCambioPin,
  esquemaInicioSesion,
  esquemaPreferencias,
  esquemaRenovacion,
  esquemaSalida,
  esquemaSesionIniciada,
  esquemaUsuario,
  PERMISOS,
  permisosDe,
  type InicioSesion,
  type Permiso,
  type Preferencias,
  type Rol,
  type Salida,
} from '@pos/compartido';
import { configuracion } from '../../config';
import { documentar } from '../../comun/documentar';
import { AccesoBloqueado, NoAutenticado } from '../../comun/errores';
import { fechaLocal, finDelDia } from '../../comun/fechas';
import { responder } from '../../comun/respuesta';
import { autenticar, autorizar } from '../../comun/seguridad';
import { sesionDe, type SesionActual } from '../../comun/sesion';
import { datos, validar } from '../../comun/validar';
import { fuenteDatos } from '../../infraestructura/base-datos/fuente';
import { conTransaccion } from '../../infraestructura/base-datos/transaccion';
import { claveRedis, redis } from '../../infraestructura/redis';
import { BitacoraServicio } from '../bitacora/bitacora';
import type { UsuarioEntidad } from '../usuarios/usuarios.tablas';
import { aUsuario, UsuariosServicio } from '../usuarios/usuarios';
import { SesionEntidad } from './acceso.tablas';

export const INTENTOS_MAXIMOS = 5;
export const MINUTOS_BLOQUEO = 5;
export const MINUTOS_TOKEN_ACCESO = 15;

// --- Intentos de PIN ---
// Un solo contador, porque solo hay una caja. Vive en Redis con vencimiento de 5 minutos
// (pin:intentos y pin:bloqueo), así aguanta un reinicio de la API; si Redis no responde, se cuenta
// en memoria.

const CLAVE_INTENTOS = 'pin:intentos';
const CLAVE_BLOQUEO = 'pin:bloqueo';

export class IntentosPin {
  private fallos = 0;
  private bloqueadoHasta: number | null = null;

  /** Segundos que faltan para terminar el bloqueo (0 si no hay bloqueo). */
  async segundosDeBloqueo(): Promise<number> {
    let hasta = this.bloqueadoHasta;
    try {
      // Se guarda el instante en que termina; el vencimiento de Redis solo sirve para limpiar la clave.
      const valor = await redis.get(claveRedis(CLAVE_BLOQUEO));
      hasta = valor === null ? null : Number(valor);
    } catch {
      // Sin Redis, se usa lo que hay en memoria.
    }
    if (!hasta) return 0;
    return Math.max(0, Math.ceil((hasta - Date.now()) / 1000));
  }

  /** Suma un fallo y regresa cuántos van seguidos. */
  async registrarFallo(): Promise<number> {
    try {
      const fallos = await redis.incr(claveRedis(CLAVE_INTENTOS));
      await redis.expire(claveRedis(CLAVE_INTENTOS), MINUTOS_BLOQUEO * 60);
      return fallos;
    } catch {
      return ++this.fallos;
    }
  }

  /** Bloquea los minutos indicados y reinicia la cuenta. */
  async bloquear(minutos: number): Promise<void> {
    this.bloqueadoHasta = Date.now() + minutos * 60_000;
    this.fallos = 0;
    try {
      await redis.set(claveRedis(CLAVE_BLOQUEO), String(this.bloqueadoHasta), { EX: minutos * 60 });
      await redis.del(claveRedis(CLAVE_INTENTOS));
    } catch {
      // El bloqueo se queda en memoria.
    }
  }

  /** Se llama cuando el PIN es correcto. */
  async reiniciar(): Promise<void> {
    this.fallos = 0;
    this.bloqueadoHasta = null;
    try {
      await redis.del([claveRedis(CLAVE_INTENTOS), claveRedis(CLAVE_BLOQUEO)]);
    } catch {
      // Sin Redis, lo de memoria ya quedó en cero.
    }
  }
}

/** El contador de la caja. */
export const intentosPin = new IntentosPin();

// --- Reglas ---

/** Contenido del JWT: usuario (sub), sesión (sid) y rol. */
interface ContenidoToken {
  sub: string;
  sid: string;
  rol: Rol;
}

/** Respuesta del inicio de sesión. */
export interface SesionEmitida {
  tokenAcceso: string;
  tokenRenovacion: string;
  expiraEn: Date;
  usuario: UsuarioEntidad;
  permisos: Permiso[];
}

/** Hash SHA-256, para guardar el token de renovación sin que se pueda leer. */
const sha256 = (texto: string) => createHash('sha256').update(texto).digest('hex');

export class AccesoServicio {
  private sesiones = fuenteDatos.getRepository(SesionEntidad);
  private usuarios = new UsuariosServicio();
  private bitacora = new BitacoraServicio();

  /** Entrar con PIN; motivo es 'INICIO' o 'DESBLOQUEO' (cuando se bloqueó por inactividad). */
  async iniciarSesion(pin: string, motivo: 'INICIO' | 'DESBLOQUEO'): Promise<SesionEmitida> {
    // Caja bloqueada por intentos fallidos → 423.
    const segundos = await intentosPin.segundosDeBloqueo();
    if (segundos > 0) throw new AccesoBloqueado(segundos);

    const usuario = await this.usuarios.usuarioActivoPorPin(pin);

    // PIN incorrecto: se cuenta, se apunta en la bitácora y al quinto se bloquea.
    if (!usuario) {
      const fallos = await intentosPin.registrarFallo();
      await this.bitacora.registrar({ usuarioId: null, accion: 'ACCESO_FALLIDO', entidad: 'sesion' });
      if (fallos >= INTENTOS_MAXIMOS) {
        await intentosPin.bloquear(MINUTOS_BLOQUEO);
        await this.bitacora.registrar({ usuarioId: null, accion: 'ACCESO_BLOQUEADO', entidad: 'sesion' });
        throw new AccesoBloqueado(MINUTOS_BLOQUEO * 60);
      }
      const restantes = INTENTOS_MAXIMOS - fallos;
      throw new NoAutenticado(
        `PIN incorrecto. Le quedan ${restantes} ${restantes === 1 ? 'intento' : 'intentos'}`,
      );
    }

    await intentosPin.reiniciar();

    // Token de renovación al azar: el usuario lo recibe una sola vez y en la base solo queda su hash.
    const tokenRenovacion = randomBytes(32).toString('base64url');
    const sesion = this.sesiones.create({
      id: randomUUID(),
      usuarioId: usuario.id,
      tokenHash: sha256(tokenRenovacion),
      creadaEn: new Date(),
      expiraEn: finDelDia(fechaLocal(new Date())),
      revocadaEn: null,
    });

    // Sesión y bitácora en la misma transacción.
    await conTransaccion(async (manager) => {
      await manager.save(sesion);
      await this.bitacora.registrar(
        {
          usuarioId: usuario.id,
          accion: motivo === 'DESBLOQUEO' ? 'SESION_DESBLOQUEADA' : 'ACCESO',
          entidad: 'sesion',
          entidadId: sesion.id,
        },
        manager,
      );
    });

    return {
      ...this.tokenDeAcceso(usuario, sesion.id),
      tokenRenovacion,
      usuario,
      permisos: permisosDe(usuario.rol),
    };
  }

  /** Da un token de acceso nuevo a cambio del de renovación. */
  async renovar(tokenRenovacion: string): Promise<Omit<SesionEmitida, 'tokenRenovacion'>> {
    const sesion = await this.sesiones.findOneBy({ tokenHash: sha256(tokenRenovacion) });
    if (!sesion || !this.vigente(sesion)) {
      throw new NoAutenticado('La sesión terminó; inicie sesión con su PIN');
    }
    const usuario = await this.usuarios.usuarioActivoPorId(sesion.usuarioId);
    if (!usuario) throw new NoAutenticado('El usuario ya no está activo');
    return { ...this.tokenDeAcceso(usuario, sesion.id), usuario, permisos: permisosDe(usuario.rol) };
  }

  /**
   * Salir; motivo es 'MANUAL' o 'INACTIVIDAD'. Regla: si fue por inactividad, la venta en curso se
   * guarda para cuando se vuelva a entrar.
   */
  async salir(actual: SesionActual, motivo: 'MANUAL' | 'INACTIVIDAD'): Promise<void> {
    await conTransaccion(async (manager) => {
      await manager.update(SesionEntidad, { id: actual.sesionId }, { revocadaEn: new Date() });
      await this.bitacora.registrar(
        {
          usuarioId: actual.usuarioId,
          accion: motivo === 'INACTIVIDAD' ? 'SESION_BLOQUEADA' : 'SALIDA',
          entidad: 'sesion',
          entidadId: actual.sesionId,
        },
        manager,
      );
    });
  }

  /**
   * La usa autenticar en cada petición: revisa que el JWT sea bueno y no haya vencido, que la sesión
   * siga abierta y que el usuario siga activo. Si algo no cuadra, responde 401.
   */
  async verificar(token: string): Promise<SesionActual> {
    let contenido: ContenidoToken;
    try {
      contenido = jwt.verify(token, configuracion.jwtSecreto, { algorithms: ['HS256'] }) as ContenidoToken;
    } catch {
      throw new NoAutenticado('La sesión venció o no es válida; inicie sesión con su PIN');
    }
    const sesion = await this.sesiones.findOneBy({ id: contenido.sid });
    if (!sesion || !this.vigente(sesion)) {
      throw new NoAutenticado('La sesión terminó; inicie sesión con su PIN');
    }
    const usuario = await this.usuarios.usuarioActivoPorId(contenido.sub);
    if (!usuario) throw new NoAutenticado('El usuario ya no está activo');
    return {
      usuarioId: usuario.id,
      rol: usuario.rol,
      sesionId: sesion.id,
      debeCambiarPin: usuario.debeCambiarPin,
    };
  }

  /** La sesión sirve si no se ha cerrado ni vencido. */
  private vigente(sesion: SesionEntidad): boolean {
    return !sesion.revocadaEn && sesion.expiraEn > new Date();
  }

  /** JWT de acceso firmado con jwtSecreto; la firma evita que alguien lo falsifique o se cambie el rol. */
  private tokenDeAcceso(usuario: UsuarioEntidad, sesionId: string) {
    const contenido: ContenidoToken = { sub: usuario.id, sid: sesionId, rol: usuario.rol };
    const tokenAcceso = jwt.sign(contenido, configuracion.jwtSecreto, {
      algorithm: 'HS256',
      expiresIn: MINUTOS_TOKEN_ACCESO * 60, // segundos
    });
    return { tokenAcceso, expiraEn: new Date(Date.now() + MINUTOS_TOKEN_ACCESO * 60_000) };
  }
}

// --- Rutas ---
// /auth/pin y /auth/renovar son públicas. Las demás solo piden autenticar (sin autorizar), para que
// funcionen aunque el usuario todavía traiga el PIN temporal.

export function rutasAcceso(): Router {
  const router = Router();
  const acceso = new AccesoServicio();
  const usuarios = new UsuariosServicio();

  // POST /auth/pin  { pin, motivo }
  router.post('/auth/pin', validar({ body: esquemaInicioSesion }), async (req, res) => {
    const { pin, motivo } = datos<InicioSesion>(req, 'body');
    const s = await acceso.iniciarSesion(pin, motivo);
    responder(
      res,
      {
        tokenAcceso: s.tokenAcceso,
        tokenRenovacion: s.tokenRenovacion,
        expiraEn: s.expiraEn.toISOString(),
        usuario: aUsuario(s.usuario),
        permisos: s.permisos,
      },
      'Sesión iniciada',
    );
  });

  // POST /auth/renovar  { tokenRenovacion }
  router.post('/auth/renovar', validar({ body: esquemaRenovacion }), async (req, res) => {
    const { tokenRenovacion } = datos<{ tokenRenovacion: string }>(req, 'body');
    const s = await acceso.renovar(tokenRenovacion);
    responder(
      res,
      {
        tokenAcceso: s.tokenAcceso,
        expiraEn: s.expiraEn.toISOString(),
        usuario: aUsuario(s.usuario),
        permisos: s.permisos,
      },
      'Sesión renovada',
    );
  });

  // POST /auth/salir  { motivo }
  router.post('/auth/salir', autenticar, validar({ body: esquemaSalida }), async (req, res) => {
    await acceso.salir(sesionDe(req), datos<Salida>(req, 'body').motivo);
    responder(res, null, 'Sesión cerrada');
  });

  // GET /auth/yo → usuario y permisos de la sesión
  router.get('/auth/yo', autenticar, async (req, res) => {
    const usuario = (await usuarios.usuarioActivoPorId(sesionDe(req).usuarioId))!;
    responder(res, { usuario: aUsuario(usuario), permisos: permisosDe(usuario.rol) }, 'Sesión actual');
  });

  // PATCH /auth/mi-pin  { pin }
  router.patch('/auth/mi-pin', autenticar, validar({ body: esquemaCambioPin }), async (req, res) => {
    const { pin } = datos<{ pin: string }>(req, 'body');
    const usuario = await usuarios.cambiarMiPin(sesionDe(req).usuarioId, pin);
    responder(res, aUsuario(usuario), 'PIN actualizado');
  });

  // PATCH /auth/preferencias  { modoAccesible, tamanoLetra }
  router.patch(
    '/auth/preferencias',
    autenticar,
    autorizar(),
    validar({ body: esquemaPreferencias }),
    async (req, res) => {
      const preferencias = datos<Preferencias>(req, 'body');
      const usuario = await usuarios.guardarPreferencias(sesionDe(req).usuarioId, preferencias);
      responder(res, aUsuario(usuario), 'Preferencias guardadas');
    },
  );

  return router;
}

// --- Swagger ---

export function documentarAcceso(registro: OpenAPIRegistry): void {
  const etiqueta = 'Acceso';
  documentar(registro, [
    {
      metodo: 'post',
      ruta: '/auth/pin',
      resumen: 'Iniciar sesión o desbloquear con el PIN',
      etiqueta,
      publica: true,
      body: esquemaInicioSesion,
      respuesta: esquemaSesionIniciada,
      errores: [401, 423],
    },
    {
      metodo: 'post',
      ruta: '/auth/renovar',
      resumen: 'Renovar el token de acceso con el token de renovación',
      etiqueta,
      publica: true,
      body: esquemaRenovacion,
      respuesta: esquemaSesionIniciada.omit({ tokenRenovacion: true }),
      errores: [401],
    },
    {
      metodo: 'post',
      ruta: '/auth/salir',
      resumen: 'Cerrar sesión o bloquear por inactividad',
      etiqueta,
      body: esquemaSalida,
    },
    {
      metodo: 'get',
      ruta: '/auth/yo',
      resumen: 'Usuario de la sesión y sus permisos',
      etiqueta,
      respuesta: z.object({ usuario: esquemaUsuario, permisos: z.array(z.enum(PERMISOS)) }),
    },
    {
      metodo: 'patch',
      ruta: '/auth/mi-pin',
      resumen: 'Cambiar el PIN propio (obligatorio con el PIN temporal)',
      etiqueta,
      body: esquemaCambioPin,
      respuesta: esquemaUsuario,
      errores: [409],
    },
    {
      metodo: 'patch',
      ruta: '/auth/preferencias',
      resumen: 'Guardar el modo accesible y el tamaño de letra del perfil',
      etiqueta,
      body: esquemaPreferencias,
      respuesta: esquemaUsuario,
    },
  ]);
}
