/** Lo que se valida en los respaldos de la base de datos. */
import { z } from 'zod';
import { esquemaPaginacion } from './comunes';

export const ESTADOS_RESPALDO = ['PENDIENTE', 'CORRECTO', 'FALLIDO'] as const;
export type EstadoRespaldo = (typeof ESTADOS_RESPALDO)[number];

export const esquemaConsultaRespaldos = esquemaPaginacion;

export const esquemaRespaldo = z.object({
  id: z.string(),
  archivo: z.string(),
  bytes: z.number().nullable(),
  estado: z.enum(ESTADOS_RESPALDO),
  error: z.string().nullable(),
  disponible: z.boolean(), // el archivo sigue en la carpeta (solo se guardan los últimos 7)
  creadoEn: z.string(),
  terminadoEn: z.string().nullable(),
});

export type ConsultaRespaldos = z.infer<typeof esquemaConsultaRespaldos>;
export type Respaldo = z.infer<typeof esquemaRespaldo>;
