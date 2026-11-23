/** Lo que se valida para entrar al sistema y dar de alta usuarios: PIN, sesión y usuario nuevo. */
import { z } from 'zod';
import { esquemaPaginacion, textoRequerido } from '../esquemas/comunes';
import { PERMISOS, ROLES } from './permisos';

/** El PIN son 4 dígitos, nada más. */
export const pin = z
  .string({ error: 'Es obligatorio' })
  .regex(/^\d{4}$/, 'El PIN debe tener exactamente 4 dígitos');

/** Para entrar con PIN. Ojo: el desbloqueo por inactividad se anota aparte en la bitácora. */
export const esquemaInicioSesion = z.strictObject({
  pin,
  motivo: z.enum(['INICIO', 'DESBLOQUEO']).default('INICIO'),
});

export const esquemaRenovacion = z.strictObject({ tokenRenovacion: z.string().min(20) });

/** Para salir: a mano o porque pasaron 10 minutos sin que nadie tocara nada. */
export const esquemaSalida = z.strictObject({ motivo: z.enum(['MANUAL', 'INACTIVIDAD']).default('MANUAL') });

export const esquemaCambioPin = z.strictObject({ pin });

export const esquemaPreferencias = z
  .strictObject({
    modoAccesible: z.boolean().optional(),
    tamanoLetra: z.number().int().min(100).max(300).optional(),
  })
  .refine(
    (p) => p.modoAccesible !== undefined || p.tamanoLetra !== undefined,
    'Indique al menos una preferencia',
  );

/** Datos para dar de alta a un usuario nuevo. */
export const esquemaUsuarioNuevo = z.strictObject({
  nombre: textoRequerido(80),
  rol: z.enum(ROLES, { error: 'Debe ser DUENO o EMPLEADO' }),
  pin,
  modoAccesible: z.boolean().default(false),
});

export const esquemaUsuario = z.object({
  id: z.uuid(),
  nombre: z.string(),
  rol: z.enum(ROLES),
  modoAccesible: z.boolean(),
  tamanoLetra: z.number(),
  activo: z.boolean(),
  debeCambiarPin: z.boolean(),
});

export const esquemaSesionIniciada = z.object({
  tokenAcceso: z.string(),
  tokenRenovacion: z.string(),
  expiraEn: z.string(),
  usuario: esquemaUsuario,
  permisos: z.array(z.enum(PERMISOS)),
});

const fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use el formato AAAA-MM-DD');

/** Filtros para consultar la bitácora. */
export const esquemaConsultaBitacora = esquemaPaginacion.extend({
  desde: fecha.optional(),
  hasta: fecha.optional(),
  usuarioId: z.uuid().optional(),
  accion: z.string().trim().min(1).max(40).optional(),
});

export const esquemaRegistroBitacora = z.object({
  id: z.uuid(),
  fecha: z.string(),
  usuarioId: z.string().nullable(),
  accion: z.string(),
  entidad: z.string(),
  entidadId: z.string().nullable(),
  antes: z.unknown().nullable(),
  despues: z.unknown().nullable(),
});

export type InicioSesion = z.infer<typeof esquemaInicioSesion>;
export type Salida = z.infer<typeof esquemaSalida>;
export type Preferencias = z.infer<typeof esquemaPreferencias>;
export type UsuarioNuevo = z.infer<typeof esquemaUsuarioNuevo>;
export type Usuario = z.infer<typeof esquemaUsuario>;
export type SesionIniciada = z.infer<typeof esquemaSesionIniciada>;
export type ConsultaBitacora = z.infer<typeof esquemaConsultaBitacora>;
export type RegistroBitacora = z.infer<typeof esquemaRegistroBitacora>;
