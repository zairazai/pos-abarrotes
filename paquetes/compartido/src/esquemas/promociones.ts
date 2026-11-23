/** Lo que se valida en las promociones. */
import { z } from 'zod';
import { UNIDADES } from './catalogo';
import { fechaValida, montoPositivo } from './comunes';

export const TIPOS_PROMOCION = ['MAYOREO', 'NXM', 'PRECIO_ESPECIAL'] as const;
export const ESTADOS_PROMOCION = ['PROGRAMADA', 'ACTIVA', 'VENCIDA'] as const;

/** Toda promoción lleva producto, fecha de inicio y fecha de fin. */
const base = {
  productoId: z.uuid('Debe ser un identificador de producto válido'),
  inicio: fechaValida,
  fin: fechaValida,
};
const piezas = z.number({ error: 'Debe ser un número entero' }).int('Debe ser un número entero').min(1);

/** Promoción nueva; cada tipo acepta solo sus propias condiciones. */
export const esquemaPromocionNueva = z
  .discriminatedUnion(
    'tipo',
    [
      z.strictObject({
        ...base,
        tipo: z.literal('MAYOREO'),
        cantidadMinima: montoPositivo,
        precio: montoPositivo,
      }),
      z.strictObject({ ...base, tipo: z.literal('NXM'), lleva: piezas.min(2), paga: piezas }),
      z.strictObject({ ...base, tipo: z.literal('PRECIO_ESPECIAL'), precio: montoPositivo }),
    ],
    { error: 'Debe ser MAYOREO, NXM o PRECIO_ESPECIAL' },
  )
  .refine((p) => p.tipo !== 'NXM' || p.paga < p.lleva, {
    message: 'Se paga menos de lo que se lleva, por ejemplo 2x1 o 3x2',
    path: ['paga'],
  })
  .refine((p) => p.fin >= p.inicio, { message: 'El fin no puede ser antes del inicio', path: ['fin'] });

export const esquemaConsultaPromociones = z.object({
  estado: z.enum(ESTADOS_PROMOCION, { error: 'Debe ser PROGRAMADA, ACTIVA o VENCIDA' }).optional(),
});

// --- Respuestas ---

export const esquemaPromocion = z.object({
  id: z.string(),
  producto: z.object({ id: z.string(), nombre: z.string(), unidad: z.enum(UNIDADES), precio: z.string() }),
  tipo: z.enum(TIPOS_PROMOCION),
  cantidadMinima: z.string().nullable(),
  precio: z.string().nullable(),
  lleva: z.number().nullable(),
  paga: z.number().nullable(),
  inicio: z.string(),
  fin: z.string(),
  estado: z.enum(ESTADOS_PROMOCION),
  creadaPor: z.string(),
  creadaEn: z.string(),
});

export type PromocionNueva = z.infer<typeof esquemaPromocionNueva>;
export type ConsultaPromociones = z.infer<typeof esquemaConsultaPromociones>;
export type Promocion = z.infer<typeof esquemaPromocion>;
