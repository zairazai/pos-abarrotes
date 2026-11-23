/**
 * Lo que se valida en los reportes del Dueño y en su exportación. Montos y cantidades van como
 * texto; cada reporte dice de qué tipo es y de qué periodo.
 */
import { z } from 'zod';
import { UNIDADES } from './catalogo';
import { esquemaPaginacion, fechaValida } from './comunes';
import { TIPOS_SALIDA } from './inventario';
import { FORMAS_REEMBOLSO } from './devoluciones';

export const TIPOS_REPORTE = [
  'ventas',
  'ganancia',
  'mas-vendidos',
  'cortes',
  'inventario',
  'mermas',
  'cancelaciones',
  'empleados',
] as const;
export type TipoReporte = (typeof TIPOS_REPORTE)[number];

export const esquemaTipoReporte = z.object({
  tipo: z.enum(TIPOS_REPORTE, { error: `Reporte inexistente; use ${TIPOS_REPORTE.join(', ')}` }),
});

/** Días de la tienda, incluidos los dos extremos; sin fechas es hoy. */
export const esquemaConsultaReporte = z.object({
  desde: fechaValida.optional(),
  hasta: fechaValida.optional(),
});

// --- Partes que se repiten ---

const texto = z.string(); // monto o cantidad decimal, por ejemplo "125.50"
const producto = { productoId: z.string(), nombre: z.string(), unidad: z.enum(UNIDADES) };
const periodo = { desde: z.string(), hasta: z.string() };

/** Totales de ventas de un día o del periodo. */
const cifrasVentas = z.object({
  ventas: z.number(), // ventas cobradas
  total: texto, // lo cobrado, con el redondeo del efectivo
  efectivo: texto,
  tarjeta: texto,
  transferencia: texto,
  saldoFavor: texto,
  devuelto: texto, // importe de las devoluciones
  neto: texto, // total menos devuelto
});

const cifrasGanancia = z.object({
  venta: texto, // lo cobrado menos lo devuelto
  costo: texto,
  ganancia: texto,
  margen: z.string().nullable(), // porcentaje sobre la venta
});

const vendido = z.object({ ...producto, cantidad: texto, venta: texto });

// --- Los 8 reportes ---

export const esquemaReporteVentas = z.object({
  tipo: z.literal('ventas'),
  ...periodo,
  dias: z.array(cifrasVentas.extend({ fecha: z.string() })),
  totales: cifrasVentas,
});

export const esquemaReporteGanancia = z.object({
  tipo: z.literal('ganancia'),
  ...periodo,
  productos: z.array(cifrasGanancia.extend({ ...producto, cantidad: texto })),
  totales: cifrasGanancia,
});

export const esquemaReporteMasVendidos = z.object({
  tipo: z.literal('mas-vendidos'),
  ...periodo,
  masVendidos: z.array(vendido),
  menosVendidos: z.array(vendido), // incluye los activos que no se vendieron
});

export const esquemaReporteCortes = z.object({
  tipo: z.literal('cortes'),
  ...periodo,
  cajas: z.array(
    z.object({
      fecha: z.string(),
      estado: z.enum(['ABIERTA', 'CERRADA']),
      abiertaPor: z.string(),
      cerradaPor: z.string().nullable(),
      fondoInicial: texto,
      esperado: texto.nullable(),
      contado: texto.nullable(),
      diferencia: texto.nullable(),
      justificacion: z.string().nullable(),
    }),
  ),
  totales: z.object({ cajas: z.number(), diferencia: texto }),
});

/** Inventario valorizado: siempre al momento, sin importar el periodo. */
export const esquemaReporteInventario = z.object({
  tipo: z.literal('inventario'),
  ...periodo,
  productos: z.array(z.object({ ...producto, existencia: texto, valor: texto })),
  totales: z.object({ productos: z.number(), valor: texto }),
});

const cifrasSalida = z.object({ registros: z.number(), costo: texto });

export const esquemaReporteMermas = z.object({
  tipo: z.literal('mermas'),
  ...periodo,
  salidas: z.array(
    z.object({
      fecha: z.string(),
      tipo: z.enum(TIPOS_SALIDA),
      ...producto,
      cantidad: texto,
      costo: texto,
      motivo: z.string(),
      comentario: z.string().nullable(),
      usuario: z.string(),
    }),
  ),
  totales: z.object({ merma: cifrasSalida, consumo: cifrasSalida }),
});

export const esquemaReporteCancelaciones = z.object({
  tipo: z.literal('cancelaciones'),
  ...periodo,
  canceladas: z.array(
    z.object({
      fecha: z.string(),
      motivo: z.enum(['EN_CURSO', 'CIERRE']), // en pantalla o al cerrar la caja
      canceladaPor: z.string().nullable(), // null: la canceló el sistema
      renglones: z.number(),
      total: texto,
    }),
  ),
  devoluciones: z.array(
    z.object({
      fecha: z.string(),
      folio: z.number(),
      tipo: z.enum(['PARCIAL', 'TOTAL']),
      motivo: z.string(),
      formaReembolso: z.enum(FORMAS_REEMBOLSO),
      importe: texto,
      usuario: z.string(),
    }),
  ),
  totales: z.object({
    canceladas: z.number(),
    totalCancelado: texto,
    devoluciones: z.number(),
    totalDevuelto: texto,
  }),
});

export const esquemaReporteEmpleados = z.object({
  tipo: z.literal('empleados'),
  ...periodo,
  empleados: z.array(
    z.object({
      usuarioId: z.string(),
      nombre: z.string(),
      ventas: z.number(),
      total: texto,
      cancelaciones: z.number(),
      devoluciones: z.number(),
      devuelto: texto,
    }),
  ),
});

export const esquemaReporte = z.discriminatedUnion('tipo', [
  esquemaReporteVentas,
  esquemaReporteGanancia,
  esquemaReporteMasVendidos,
  esquemaReporteCortes,
  esquemaReporteInventario,
  esquemaReporteMermas,
  esquemaReporteCancelaciones,
  esquemaReporteEmpleados,
]);

// --- Exportación a PDF y Excel ---

export const FORMATOS_EXPORTACION = ['PDF', 'EXCEL'] as const;
export const ESTADOS_EXPORTACION = ['PENDIENTE', 'LISTO', 'FALLIDO'] as const;
export type FormatoExportacion = (typeof FORMATOS_EXPORTACION)[number];

export const esquemaExportacionNueva = esquemaConsultaReporte.extend({
  formato: z.enum(FORMATOS_EXPORTACION, { error: 'Use PDF o EXCEL' }),
});

export const esquemaConsultaExportaciones = esquemaPaginacion;

export const esquemaExportacion = z.object({
  id: z.string(),
  tipo: z.enum(TIPOS_REPORTE),
  formato: z.enum(FORMATOS_EXPORTACION),
  desde: z.string(),
  hasta: z.string(),
  estado: z.enum(ESTADOS_EXPORTACION),
  archivo: z.string(),
  bytes: z.number().nullable(),
  error: z.string().nullable(),
  disponible: z.boolean(), // listo y todavía en la carpeta (se guardan 30 días)
  creadoEn: z.string(),
  terminadoEn: z.string().nullable(),
});

export type ConsultaReporte = z.infer<typeof esquemaConsultaReporte>;
export type ExportacionNueva = z.infer<typeof esquemaExportacionNueva>;
export type ConsultaExportaciones = z.infer<typeof esquemaConsultaExportaciones>;
export type Exportacion = z.infer<typeof esquemaExportacion>;
export type Reporte = z.infer<typeof esquemaReporte>;
export type ReporteVentas = z.infer<typeof esquemaReporteVentas>;
export type ReporteGanancia = z.infer<typeof esquemaReporteGanancia>;
export type ReporteMasVendidos = z.infer<typeof esquemaReporteMasVendidos>;
export type ReporteCortes = z.infer<typeof esquemaReporteCortes>;
export type ReporteInventario = z.infer<typeof esquemaReporteInventario>;
export type ReporteMermas = z.infer<typeof esquemaReporteMermas>;
export type ReporteCancelaciones = z.infer<typeof esquemaReporteCancelaciones>;
export type ReporteEmpleados = z.infer<typeof esquemaReporteEmpleados>;
