/** Lo que se valida en la caja: apertura, movimientos, arqueo y cierre. */
import { z } from 'zod';
import { CLAVES_DENOMINACION, TIPOS_MOVIMIENTO, type ClaveDenominacion } from '../dominio/caja';
import { montoPositivo, textoRequerido } from './comunes';
import { esquemaResumenAlertas } from './inventario';
import { esquemaVentaAbierta } from './ventas';

const cantidad = z
  .number({ error: 'Debe ser un número de piezas' })
  .int('Debe ser un número entero de piezas')
  .min(0, 'No puede ser negativo')
  .max(100_000, 'Es demasiado grande');

/** Conteo por billete o moneda, por ejemplo { "B500": 2, "M050": 3 }; lo que falte vale cero. */
export const esquemaConteo = z.strictObject(
  Object.fromEntries(CLAVES_DENOMINACION.map((c) => [c, cantidad.optional()])) as Record<
    ClaveDenominacion,
    z.ZodOptional<typeof cantidad>
  >,
);

/** Abrir la caja; el conteo del fondo solo se manda el primer día. */
export const esquemaApertura = z.strictObject({ fondoInicial: esquemaConteo.optional() });

/** Sacar o meter dinero a la caja; el motivo es obligatorio. */
export const esquemaMovimientoNuevo = z.strictObject({
  tipo: z.enum(TIPOS_MOVIMIENTO, { error: 'Debe ser RETIRO o INGRESO' }),
  monto: montoPositivo,
  motivo: textoRequerido(200),
});

/** Conteo del efectivo para cerrar. */
export const esquemaArqueo = z.strictObject({ conteo: esquemaConteo });

/**
 * Cierre de caja. Si después de volver a contar sigue sin cuadrar, hay que justificarlo; también se
 * mandan las ventas que quedaron abiertas para cancelarlas.
 */
export const esquemaCierre = z.strictObject({
  justificacion: textoRequerido(300).optional(),
  ventasAbiertas: z.array(esquemaVentaAbierta).max(50).default([]),
});

// --- Respuestas ---

const resultadoArqueo = z.enum(['CUADRA', 'RECONTAR', 'JUSTIFICAR']);

/** Movimiento de caja; un pago a proveedor trae la entrada que paga y un reembolso, su devolución. */
export const esquemaMovimiento = z.object({
  id: z.uuid(),
  tipo: z.enum([...TIPOS_MOVIMIENTO, 'PAGO_PROVEEDOR', 'DEVOLUCION']),
  monto: z.string(),
  motivo: z.string(),
  usuarioId: z.uuid(),
  fecha: z.string(),
  entradaId: z.uuid().nullable(),
  devolucionId: z.uuid().nullable(),
});

/**
 * Cómo salió un conteo. El esperado y la diferencia solo se mandan a quien tiene permiso de verlos;
 * al Empleado solo se le dice si cuadra o no (arqueo a ciegas).
 */
export const esquemaResultadoArqueo = z.object({
  intento: z.number(),
  resultado: resultadoArqueo,
  contado: z.string(),
  esperado: z.string().optional(),
  diferencia: z.string().optional(),
});

export const esquemaCaja = z.object({
  id: z.uuid(),
  fecha: z.string(),
  estado: z.enum(['ABIERTA', 'CERRADA']),
  fondoInicial: z.string(),
  abiertaPor: z.uuid(),
  abiertaEn: z.string(),
  cerradaPor: z.uuid().nullable(),
  cerradaEn: z.string().nullable(),
  /** Efectivo contado al cerrar; con eso arranca la siguiente caja. */
  efectivoFinal: z.string().nullable(),
  justificacion: z.string().nullable(),
  esperado: z.string().optional(),
  /** Efectivo que dejaron las ventas; solo para quien puede ver el esperado (arqueo a ciegas). */
  ventasEfectivo: z.string().optional(),
  diferencia: z.string().nullable().optional(),
  movimientos: z.array(esquemaMovimiento),
  ultimoArqueo: esquemaResultadoArqueo.nullable(),
});

/** Lo que responde la apertura: la caja y el resumen de alertas (null si no se pudo calcular). */
export const esquemaCajaAbierta = esquemaCaja.extend({ alertas: esquemaResumenAlertas.nullable() });

/** Estado de la caja para la pantalla de apertura y de trabajo (GET /caja/actual). */
export const esquemaCajaActual = z.object({
  /** La caja abierta (de hoy o de otro día) o la de hoy ya cerrada; null si no hay ninguna. */
  caja: esquemaCaja.nullable(),
  /** La caja abierta se quedó de otro día y hay que cerrarla primero. */
  cajaDeOtroDia: z.boolean(),
  /** Es el primer día: el Dueño tiene que capturar el fondo. */
  requiereFondoInicial: z.boolean(),
  /** Fondo sugerido: lo que quedó en efectivo al cerrar la vez pasada. */
  fondoPropuesto: z.string().nullable(),
});

export type ConteoEfectivo = z.infer<typeof esquemaConteo>;
export type Apertura = z.infer<typeof esquemaApertura>;
export type MovimientoNuevo = z.infer<typeof esquemaMovimientoNuevo>;
export type ArqueoNuevo = z.infer<typeof esquemaArqueo>;
export type Cierre = z.infer<typeof esquemaCierre>;
export type MovimientoEfectivo = z.infer<typeof esquemaMovimiento>;
export type ResultadoDeArqueo = z.infer<typeof esquemaResultadoArqueo>;
export type Caja = z.infer<typeof esquemaCaja>;
export type CajaAbierta = z.infer<typeof esquemaCajaAbierta>;
export type CajaActual = z.infer<typeof esquemaCajaActual>;
