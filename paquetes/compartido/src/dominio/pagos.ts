/**
 * Cuentas del cobro (efectivo, tarjeta, transferencia o mixto): si alcanza lo que pagan, el redondeo
 * del efectivo a 50 centavos y el cambio.
 */
import Decimal from 'decimal.js';
import { dinero, type ValorDecimal } from './importe';

export const METODOS_PAGO = ['EFECTIVO', 'TARJETA', 'TRANSFERENCIA'] as const;
export type MetodoPago = (typeof METODOS_PAGO)[number];

/** Métodos que se guardan en la venta: los de siempre más el saldo a favor de un cambio por producto. */
export const METODOS_PAGO_GUARDADOS = [...METODOS_PAGO, 'SALDO_FAVOR'] as const;
export type MetodoPagoGuardado = (typeof METODOS_PAGO_GUARDADOS)[number];

export interface Pago {
  metodo: MetodoPago;
  monto: ValorDecimal;
  /** Obligatoria con tarjeta y transferencia. */
  referencia?: string;
}

export interface Liquidacion {
  /** Total de la venta más lo que sumó el redondeo del efectivo. */
  totalCobrado: Decimal;
  /** Lo que sumó el redondeo. */
  redondeo: Decimal;
  faltante: Decimal;
  cambio: Decimal;
  cubierto: boolean;
}

const CERO = new Decimal(0);

/** Regla: si pagan en efectivo, se redondea a los 50 centavos de arriba. */
export function redondearEfectivo(monto: ValorDecimal): Decimal {
  return dinero(new Decimal(monto).times(2).ceil().dividedBy(2));
}

/**
 * Calcula el total a cobrar, cuánto falta y el cambio. Solo se redondea la parte en efectivo, y el
 * cambio siempre sale del efectivo (no se da cambio de una tarjeta).
 */
export function liquidarPagos(total: ValorDecimal, pagos: Pago[]): Liquidacion {
  const totalVenta = dinero(total);
  let efectivo = CERO;
  let otros = CERO;

  for (const pago of pagos) {
    const monto = dinero(pago.monto);
    if (monto.lte(0)) throw new RangeError('El monto de cada pago debe ser mayor a cero');
    if (pago.metodo === 'EFECTIVO') {
      efectivo = efectivo.plus(monto);
    } else {
      if (!pago.referencia?.trim()) {
        throw new RangeError('El pago con tarjeta o transferencia requiere su referencia');
      }
      otros = otros.plus(monto);
    }
  }
  if (otros.gt(totalVenta)) {
    throw new RangeError('Los pagos con tarjeta o transferencia no pueden superar el total');
  }

  const restante = totalVenta.minus(otros);
  if (efectivo.isZero()) {
    return {
      totalCobrado: totalVenta,
      redondeo: CERO,
      faltante: restante,
      cambio: CERO,
      cubierto: restante.isZero(),
    };
  }

  const efectivoACobrar = redondearEfectivo(restante);
  const redondeo = efectivoACobrar.minus(restante);
  const faltante = Decimal.max(efectivoACobrar.minus(efectivo), CERO);
  return {
    totalCobrado: totalVenta.plus(redondeo),
    redondeo,
    faltante,
    cambio: Decimal.max(efectivo.minus(efectivoACobrar), CERO),
    cubierto: faltante.isZero(),
  };
}
