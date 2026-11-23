/** Lo que se valida en los envíos de avisos. */
import { z } from 'zod';
import { esquemaPaginacion } from './comunes';

export const CANALES_ENVIO = ['CORREO', 'TELEGRAM'] as const;
export type CanalEnvio = (typeof CANALES_ENVIO)[number];
export const ESTADOS_ENVIO = ['PENDIENTE', 'ENVIADO', 'FALLIDO', 'CANCELADO'] as const;
export type EstadoEnvio = (typeof ESTADOS_ENVIO)[number];

export const esquemaConsultaEnvios = esquemaPaginacion.extend({
  estado: z.enum(ESTADOS_ENVIO, { error: 'Debe ser PENDIENTE, ENVIADO, FALLIDO o CANCELADO' }).optional(),
});

export const esquemaEnvio = z.object({
  id: z.string(),
  canal: z.enum(CANALES_ENVIO),
  tipo: z.enum(['PROMOCION', 'RESUMEN_DIA']),
  asunto: z.string(),
  estado: z.enum(ESTADOS_ENVIO),
  intentos: z.number(),
  error: z.string().nullable(),
  creadoEn: z.string(),
  enviadoEn: z.string().nullable(),
});

export type ConsultaEnvios = z.infer<typeof esquemaConsultaEnvios>;
export type Envio = z.infer<typeof esquemaEnvio>;
