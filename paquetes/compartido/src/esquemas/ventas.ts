/** Lo que se valida en las ventas: el cobro y la venta cancelada. */
import { z } from 'zod';
import Decimal from 'decimal.js';
import { METODOS_PAGO, METODOS_PAGO_GUARDADOS } from '../dominio/pagos';
import { UNIDADES } from './catalogo';
import { montoPositivo } from './comunes';

/** Descuento a mano: en pesos o en porcentaje de 1 a 100. */
export const esquemaDescuento = z
  .strictObject({
    tipo: z.enum(['MONTO', 'PORCENTAJE'], { error: 'Debe ser MONTO o PORCENTAJE' }),
    valor: montoPositivo,
  })
  .refine((d) => d.tipo !== 'PORCENTAJE' || !/^\d/.test(d.valor) || new Decimal(d.valor).lte(100), {
    message: 'El porcentaje no puede pasar de 100',
    path: ['valor'],
  });

/** Piezas enteras o kilos con 2 decimales; el servidor revisa cuál según el producto. */
const renglonBase = {
  productoId: z.uuid('Debe ser un identificador de producto válido'),
  cantidad: montoPositivo,
};

/** Un pago con su método. Regla: con tarjeta o transferencia la referencia es obligatoria. */
export const esquemaPago = z
  .strictObject({
    metodo: z.enum(METODOS_PAGO, { error: 'Debe ser EFECTIVO, TARJETA o TRANSFERENCIA' }),
    monto: montoPositivo,
    referencia: z.string().trim().min(1).max(40, 'Debe tener como máximo 40 caracteres').optional(),
  })
  .refine((p) => p.metodo === 'EFECTIVO' || !!p.referencia, {
    message: 'La referencia es obligatoria con tarjeta o transferencia',
    path: ['referencia'],
  });

/**
 * Cobro. No trae precios ni totales porque el servidor los vuelve a calcular. `iniciadaPor` es quien
 * empezó la venta, que no siempre es quien cobra.
 */
export const esquemaCobro = z.strictObject({
  iniciadaPor: z.uuid('Debe ser un identificador de usuario válido'),
  renglones: z
    .array(z.strictObject({ ...renglonBase, descuento: esquemaDescuento.optional() }))
    .min(1, 'La venta necesita al menos un producto')
    .max(200),
  descuento: esquemaDescuento.optional(),
  pagos: z.array(esquemaPago).max(10),
  // Saldo de un cambio por producto; se usa como primer pago.
  saldoFavorId: z.uuid('Debe ser un identificador de saldo a favor válido').optional(),
});

/** Venta que se cancela sin cobrar. */
export const esquemaVentaAbierta = z.strictObject({
  iniciadaPor: z.uuid('Debe ser un identificador de usuario válido'),
  renglones: z.array(z.strictObject(renglonBase)).min(1, 'La venta necesita al menos un producto').max(200),
});

/** Cabecera Idempotency-Key: una por venta, se genera al empezar el cobro. */
export const esquemaClaveIdempotencia = z.uuid('La cabecera Idempotency-Key debe ser un UUID');

export const esquemaFolio = z.object({
  folio: z.coerce
    .number({ error: 'El folio debe ser un número' })
    .int()
    .positive('El folio debe ser positivo'),
});

// --- Respuestas ---

export const esquemaVenta = z.object({
  id: z.uuid(),
  folio: z.number().nullable(),
  estado: z.enum(['COBRADA', 'CANCELADA']),
  fecha: z.string(),
  iniciadaPor: z.uuid(),
  cobradaPor: z.uuid().nullable(),
  /** null si la canceló el sistema al cerrar la caja. */
  canceladaPor: z.uuid().nullable(),
  motivoCancelacion: z.enum(['EN_CURSO', 'CIERRE']).nullable(),
  renglones: z.array(
    z.object({
      productoId: z.uuid(),
      nombre: z.string(),
      unidad: z.enum(UNIDADES),
      precio: z.string(),
      cantidad: z.string(),
      importe: z.string(),
      descuentoPromocion: z.string(),
      descuentoManual: z.string(),
    }),
  ),
  subtotal: z.string(),
  ahorroPromociones: z.string(),
  descuentoManual: z.string(),
  total: z.string(),
  /** Lo que sumó el redondeo del efectivo. */
  redondeo: z.string(),
  totalCobrado: z.string(),
  cambio: z.string(),
  pagos: z.array(
    z.object({
      metodo: z.enum(METODOS_PAGO_GUARDADOS),
      monto: z.string(),
      referencia: z.string().nullable(),
    }),
  ),
});

/** Lo que responde el cobro: la venta y los avisos de productos que se vendieron sin existencia. */
export const esquemaVentaCobrada = esquemaVenta.extend({
  avisos: z.array(z.object({ productoId: z.uuid(), nombre: z.string(), faltante: z.string() })),
});

export type Cobro = z.infer<typeof esquemaCobro>;
export type VentaAbierta = z.infer<typeof esquemaVentaAbierta>;
export type Venta = z.infer<typeof esquemaVenta>;
export type VentaCobrada = z.infer<typeof esquemaVentaCobrada>;
