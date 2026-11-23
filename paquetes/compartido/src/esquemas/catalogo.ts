/** Lo que se valida en el catálogo: productos y categorías. */
import { z } from 'zod';
import { decimalTexto, esquemaPaginacion, montoPositivo, textoRequerido } from './comunes';

/** Se vende por pieza o por kilo. */
export const UNIDADES = ['PIEZA', 'KG'] as const;
export type Unidad = (typeof UNIDADES)[number];

const codigo = z
  .string({ error: 'Es obligatorio' })
  .trim()
  .regex(/^[A-Za-z0-9-]{1,30}$/, 'Solo letras, números y guiones, hasta 30 caracteres');

const datosProducto = {
  codigo,
  nombre: textoRequerido(120),
  unidad: z.enum(UNIDADES, { error: 'Debe ser PIEZA o KG' }),
  costo: montoPositivo,
  existenciaMinima: decimalTexto,
  categoriaId: z.uuid('Debe ser un identificador de categoría válido'),
};

/** Alta de producto. */
export const esquemaProductoNuevo = z.strictObject({ ...datosProducto, precio: montoPositivo });
/** Cambios a un producto; el precio va aparte para que quede su historial. */
export const esquemaProductoModificado = z.strictObject(datosProducto);
/** Cambio de precio. */
export const esquemaCambioPrecio = z.strictObject({ precio: montoPositivo });
/** Alta de categoría. */
export const esquemaCategoriaNueva = z.strictObject({ nombre: textoRequerido(60) });

/** Búsqueda por nombre o código, por páginas. */
export const esquemaConsultaProductos = esquemaPaginacion.extend({
  buscar: z.string().trim().min(1).max(120).optional(),
  categoriaId: z.uuid().optional(),
});

export const esquemaCodigo = z.object({ codigo });

export const esquemaProducto = z.object({
  id: z.uuid(),
  codigo: z.string(),
  nombre: z.string(),
  unidad: z.enum(UNIDADES),
  precio: z.string(),
  costo: z.string(),
  existenciaMinima: z.string(),
  categoriaId: z.uuid(),
  activo: z.boolean(),
  creadoEn: z.string(),
  actualizadoEn: z.string(),
});

/** Producto con su existencia (la suma de sus lotes); puede salir negativa si se vendió sin tener. */
export const esquemaProductoConExistencia = esquemaProducto.extend({ existencia: z.string() });

export const esquemaCategoria = z.object({ id: z.uuid(), nombre: z.string() });

export const esquemaHistorialPrecio = z.object({
  precioAnterior: z.string(),
  precioNuevo: z.string(),
  fecha: z.string(),
  usuarioId: z.string().nullable(),
});

export type ProductoNuevo = z.infer<typeof esquemaProductoNuevo>;
export type ProductoModificado = z.infer<typeof esquemaProductoModificado>;
export type CambioPrecio = z.infer<typeof esquemaCambioPrecio>;
export type CategoriaNueva = z.infer<typeof esquemaCategoriaNueva>;
export type ConsultaProductos = z.infer<typeof esquemaConsultaProductos>;
export type Producto = z.infer<typeof esquemaProducto>;
export type ProductoConExistencia = z.infer<typeof esquemaProductoConExistencia>;
export type Categoria = z.infer<typeof esquemaCategoria>;
export type HistorialPrecio = z.infer<typeof esquemaHistorialPrecio>;
