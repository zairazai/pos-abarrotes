/** Lo que se valida en las devoluciones. */
import { z } from 'zod';
import { UNIDADES } from './catalogo';
import { montoPositivo, textoRequerido } from './comunes';

/** A dónde va lo devuelto: de regreso al inventario o a merma. */
export const DESTINOS_DEVOLUCION = ['INVENTARIO', 'MERMA'] as const;
export type DestinoDevolucion = (typeof DESTINOS_DEVOLUCION)[number];

/** Cómo se le regresa al cliente: en efectivo o como saldo a favor para otra compra del mismo día. */
export const FORMAS_REEMBOLSO = ['EFECTIVO', 'SALDO_FAVOR'] as const;
export type FormaReembolso = (typeof FORMAS_REEMBOLSO)[number];

/**
 * Devolución por folio. Regla: el motivo es obligatorio. Cada renglón dice a dónde va, y si no se
 * indica otra cosa el reembolso es en efectivo.
 */
export const esquemaDevolucionNueva = z.strictObject({
  folio: z.number({ error: 'El folio debe ser un número' }).int().positive('El folio debe ser positivo'),
  motivo: textoRequerido(100),
  renglones: z
    .array(
      z.strictObject({
        renglon: z.number({ error: 'El renglón debe ser un número' }).int().positive(),
        cantidad: montoPositivo,
        destino: z.enum(DESTINOS_DEVOLUCION, { error: 'Debe ser INVENTARIO o MERMA' }),
      }),
    )
    .min(1, 'Indique al menos un producto a devolver'),
  reembolso: z.enum(FORMAS_REEMBOLSO, { error: 'Debe ser EFECTIVO o SALDO_FAVOR' }).default('EFECTIVO'),
});

// --- Respuestas ---

/** Venta del día con lo que todavía se puede devolver de cada renglón. */
export const esquemaVentaDevolvible = z.object({
  venta: z.object({
    id: z.string(),
    folio: z.number(),
    fecha: z.string(),
    totalCobrado: z.string(),
    reembolsado: z.string(),
  }),
  renglones: z.array(
    z.object({
      renglon: z.number(),
      productoId: z.string(),
      nombre: z.string(),
      unidad: z.enum(UNIDADES),
      vendida: z.string(),
      devuelta: z.string(),
      devolvible: z.string(),
      neto: z.string(), // lo que se pagó por el renglón completo
    }),
  ),
});

export const esquemaDevolucion = z.object({
  id: z.string(),
  folio: z.number(),
  tipo: z.enum(['PARCIAL', 'TOTAL']),
  motivo: z.string(),
  formaReembolso: z.enum(FORMAS_REEMBOLSO),
  reembolso: z.string(), // efectivo que se le dio al cliente
  // Si fue cambio por producto: el saldo para la venta nueva (POST /ventas con saldoFavorId).
  saldoFavor: z.object({ id: z.string(), monto: z.string() }).nullable(),
  renglones: z.array(
    z.object({
      renglon: z.number(),
      productoId: z.string(),
      nombre: z.string(),
      cantidad: z.string(),
      destino: z.enum(DESTINOS_DEVOLUCION),
      importe: z.string(),
    }),
  ),
  usuarioId: z.string(),
  fecha: z.string(),
});

export type DevolucionNueva = z.infer<typeof esquemaDevolucionNueva>;
export type VentaDevolvible = z.infer<typeof esquemaVentaDevolvible>;
export type Devolucion = z.infer<typeof esquemaDevolucion>;
