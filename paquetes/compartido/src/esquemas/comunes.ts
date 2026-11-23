/** Piezas que se reusan en todos lados: montos, textos obligatorios, fechas y paginación. */
import { z } from 'zod';
import Decimal from 'decimal.js';

const DECIMAL_2 = /^\d{1,10}(\.\d{1,2})?$/;

/** Los montos y pesos viajan como texto ("125.50") para no perder precisión en el camino. */
export const decimalTexto = z
  .string({ error: 'Debe ser un número en texto, por ejemplo "18.50"' })
  .trim()
  .regex(DECIMAL_2, 'Debe ser un número con hasta 2 decimales, por ejemplo "18.50"');

// Ojo: Zod 4 corre el refine aunque la expresión regular haya fallado, por eso aquí se revisa otra vez.
export const montoPositivo = decimalTexto.refine(
  (v) => !DECIMAL_2.test(v) || new Decimal(v).gt(0),
  'Debe ser mayor a cero',
);

export const textoRequerido = (max: number) =>
  z
    .string({ error: 'Es obligatorio' })
    .trim()
    .min(1, 'Es obligatorio')
    .max(max, `Debe tener como máximo ${max} caracteres`);

/** Fecha AAAA-MM-DD que existe en el calendario. */
export const fechaValida = z
  .string({ error: 'Es obligatorio' })
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use el formato AAAA-MM-DD')
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(v);
  }, 'La fecha no existe');

export const esquemaId = z.object({ id: z.uuid('Debe ser un identificador válido') });

export const esquemaPaginacion = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export interface Paginacion {
  page: number;
  limit: number;
  totalPages: number;
  totalRecords: number;
}
