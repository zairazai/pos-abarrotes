/** Lo que se valida en el inventario: proveedores, entradas, salidas, ajustes, existencias y alertas. */
import { z } from 'zod';
import { UNIDADES } from './catalogo';
import { decimalTexto, esquemaPaginacion, montoPositivo, textoRequerido, fechaValida } from './comunes';

/** Alta de proveedor: el nombre y, si se tiene, el teléfono. */
export const esquemaProveedorNuevo = z.strictObject({
  nombre: textoRequerido(80),
  telefono: z
    .string()
    .trim()
    .max(20, 'Debe tener como máximo 20 caracteres')
    .default('')
    .refine((v) => /^[\d\s()+-]*$/.test(v), 'Solo dígitos, espacios, guiones, paréntesis y +'),
});

export const esquemaProveedor = z.object({
  id: z.string(),
  nombre: z.string(),
  telefono: z.string(),
  creadoEn: z.string(),
});

/**
 * Un renglón de la entrada. La caducidad siempre se manda: una fecha, o null si el producto no caduca
 * ("No aplica"). Que las piezas sean enteras se revisa en el servidor, según el producto.
 */
const esquemaRenglonEntrada = z.strictObject({
  productoId: z.uuid('Debe ser un identificador de producto válido'),
  cantidad: montoPositivo,
  costoUnitario: montoPositivo,
  caducidad: fechaValida.nullable(),
});

/**
 * Pago al proveedor con dinero de la caja. Regla: la nota se paga completa. Si no se manda motivo,
 * se propone uno con el folio de la nota.
 */
export const esquemaPagoProveedor = z.strictObject({
  monto: montoPositivo,
  motivo: textoRequerido(200).optional(),
});

/** Entrada de mercancía; el pago es opcional y se puede registrar después. */
export const esquemaEntradaNueva = z.strictObject({
  proveedorId: z.uuid('Debe ser un identificador de proveedor válido'),
  folioNota: textoRequerido(40),
  renglones: z.array(esquemaRenglonEntrada).min(1, 'La entrada necesita al menos un producto'),
  pago: esquemaPagoProveedor.optional(),
});

export const esquemaConsultaEntradas = esquemaPaginacion;

/** Salidas que no son venta; siempre con motivo. */
export const TIPOS_SALIDA = ['MERMA', 'CONSUMO'] as const;

/**
 * Merma o consumo propio, con motivo obligatorio. Si no se dice de qué lote, se toma el que caduca
 * primero y todavía tiene existencia.
 */
export const esquemaSalidaNueva = z.strictObject({
  tipo: z.enum(TIPOS_SALIDA, { error: 'Debe ser MERMA o CONSUMO' }),
  productoId: z.uuid('Debe ser un identificador de producto válido'),
  loteId: z.uuid('Debe ser un identificador de lote válido').optional(),
  cantidad: montoPositivo,
  motivo: textoRequerido(100),
  comentario: textoRequerido(300).optional(),
});

/** Ajuste por conteo: lo que se contó de verdad (puede ser cero). */
export const esquemaAjusteNuevo = z.strictObject({
  productoId: z.uuid('Debe ser un identificador de producto válido'),
  contada: decimalTexto,
});

// --- Respuestas ---

/** Existencia de un producto con sus lotes, del que caduca primero al último. */
export const esquemaExistencias = z.object({
  producto: z.object({ id: z.string(), codigo: z.string(), nombre: z.string(), unidad: z.enum(UNIDADES) }),
  existencia: z.string(),
  existenciaMinima: z.string(),
  enMinimo: z.boolean(),
  /** Solo los lotes con existencia distinta de cero. */
  lotes: z.array(
    z.object({
      id: z.string(),
      caducidad: z.string().nullable(),
      /** Negativo si ya caducó; null si no caduca. */
      diasParaCaducar: z.number().nullable(),
      existencia: z.string(),
      origen: z.string(),
      creadoEn: z.string(),
    }),
  ),
});

/** Alertas de inventario; se calculan en el momento de consultar. */
export const esquemaAlertas = z.object({
  fecha: z.string(),
  minimo: z.array(
    z.object({
      productoId: z.string(),
      nombre: z.string(),
      unidad: z.enum(UNIDADES),
      existencia: z.string(),
      existenciaMinima: z.string(),
    }),
  ),
  caducidad: z.array(
    z.object({
      loteId: z.string(),
      productoId: z.string(),
      nombre: z.string(),
      caducidad: z.string(),
      diasParaCaducar: z.number(),
      caducado: z.boolean(),
      existencia: z.string(),
    }),
  ),
  // Resumen de la última revisión diaria de caducidades; null si nunca se ha hecho.
  ultimaRevision: z
    .object({ fecha: z.string(), ejecutadaEn: z.string(), porCaducar: z.number(), caducados: z.number() })
    .nullable(),
});

/** Resumen de alertas que sale al abrir la caja. */
export const esquemaResumenAlertas = z.object({
  minimo: z.number(),
  porCaducar: z.number(),
  caducados: z.number(),
  /** Frase lista para mostrar y leer en voz alta, por ejemplo "Sin alertas de inventario". */
  mensaje: z.string(),
});

/** Ajuste por conteo; si lo contado ya coincidía, id es null y no hay lotes. */
export const esquemaAjusteInventario = z.object({
  id: z.string().nullable(),
  producto: z.object({ id: z.string(), nombre: z.string(), unidad: z.enum(UNIDADES) }),
  registrada: z.string(),
  contada: z.string(),
  diferencia: z.string(),
  lotes: z.array(
    z.object({
      loteId: z.string(),
      cambio: z.string(),
      /** Lo que queda en el lote después del ajuste. */
      existencia: z.string(),
    }),
  ),
  usuarioId: z.string(),
  fecha: z.string().nullable(),
});

export const esquemaSalidaInventario = z.object({
  id: z.string(),
  tipo: z.enum(TIPOS_SALIDA),
  producto: z.object({ id: z.string(), nombre: z.string(), unidad: z.enum(UNIDADES) }),
  loteId: z.string(),
  caducidad: z.string().nullable(),
  cantidad: z.string(),
  /** Lo que queda en el lote después de la salida. */
  existenciaLote: z.string(),
  motivo: z.string(),
  comentario: z.string().nullable(),
  usuarioId: z.string(),
  fecha: z.string(),
});

/** Pago de una entrada; null si todavía no se paga. */
export const esquemaPagoEntrada = z.object({
  movimientoId: z.string(),
  monto: z.string(),
  motivo: z.string(),
  usuarioId: z.string(),
  fecha: z.string(),
});

export const esquemaEntrada = z.object({
  id: z.string(),
  proveedor: z.object({ id: z.string(), nombre: z.string() }),
  folioNota: z.string(),
  fecha: z.string(),
  usuarioId: z.string(),
  total: z.string(),
  pago: esquemaPagoEntrada.nullable(),
  renglones: z.array(
    z.object({
      productoId: z.string(),
      nombre: z.string(),
      unidad: z.enum(UNIDADES),
      cantidad: z.string(),
      costoUnitario: z.string(),
      importe: z.string(),
      caducidad: z.string().nullable(),
      loteId: z.string(),
    }),
  ),
});

export type ProveedorNuevo = z.infer<typeof esquemaProveedorNuevo>;
export type Proveedor = z.infer<typeof esquemaProveedor>;
export type PagoProveedor = z.infer<typeof esquemaPagoProveedor>;
export type EntradaNueva = z.infer<typeof esquemaEntradaNueva>;
export type ConsultaEntradas = z.infer<typeof esquemaConsultaEntradas>;
export type TipoSalida = (typeof TIPOS_SALIDA)[number];
export type SalidaNueva = z.infer<typeof esquemaSalidaNueva>;
export type SalidaInventario = z.infer<typeof esquemaSalidaInventario>;
export type AjusteNuevo = z.infer<typeof esquemaAjusteNuevo>;
export type AjusteInventario = z.infer<typeof esquemaAjusteInventario>;
export type Existencias = z.infer<typeof esquemaExistencias>;
export type Alertas = z.infer<typeof esquemaAlertas>;
export type ResumenAlertas = z.infer<typeof esquemaResumenAlertas>;
export type Entrada = z.infer<typeof esquemaEntrada>;
