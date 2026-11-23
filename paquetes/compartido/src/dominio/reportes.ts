/** Cuentas de los reportes del Dueño: periodo, ganancia y margen. */
import Decimal from 'decimal.js';
import { dinero, type ValorDecimal } from './importe';

/** Un reporte abarca como máximo un año, para que la consulta no se tarde de más. */
export const DIAS_MAXIMOS_REPORTE = 366;

const DIA_MS = 24 * 60 * 60 * 1000;

/**
 * Periodo del reporte en días de la tienda (AAAA-MM-DD), con los dos extremos incluidos. Sin fechas
 * es hoy; si solo viene `hasta`, empieza ese mismo día.
 */
export function periodoReporte(
  desde: string | undefined,
  hasta: string | undefined,
  hoy: string,
): { desde: string; hasta: string } {
  const fin = hasta ?? hoy;
  const inicio = desde ?? hasta ?? hoy;
  if (inicio > fin) throw new RangeError('La fecha desde no puede ser posterior a la fecha hasta');
  const dias = (Date.parse(`${fin}T00:00:00Z`) - Date.parse(`${inicio}T00:00:00Z`)) / DIA_MS + 1;
  if (dias > DIAS_MAXIMOS_REPORTE) {
    throw new RangeError(`El periodo no puede pasar de ${DIAS_MAXIMOS_REPORTE} días`);
  }
  return { desde: inicio, hasta: fin };
}

/** Cantidad y costo unitario de un lote (el de su nota de entrada o, si no tiene, el del producto). */
export interface CantidadConCosto {
  cantidad: ValorDecimal;
  costo: ValorDecimal;
}

const costoDe = (lotes: CantidadConCosto[]) =>
  lotes.reduce((total, l) => total.plus(new Decimal(l.cantidad).times(l.costo)), new Decimal(0));

/**
 * Ganancia de un renglón vendido: lo cobrado menos lo devuelto, contra el costo de los lotes de donde
 * salió menos el de los lotes a los que regresó. En corto: venta menos costo.
 */
export function gananciaDeRenglon(renglon: {
  neto: ValorDecimal; // importe menos descuentos
  devuelto: ValorDecimal; // importe que se reembolsó
  vendidos: CantidadConCosto[];
  devueltos: CantidadConCosto[];
}): { venta: Decimal; costo: Decimal; ganancia: Decimal } {
  const venta = dinero(new Decimal(renglon.neto).minus(renglon.devuelto));
  const costo = dinero(costoDe(renglon.vendidos).minus(costoDe(renglon.devueltos)));
  return { venta, costo, ganancia: venta.minus(costo) };
}

/** Margen sobre la venta en porcentaje con un decimal ("23.5"); sin venta, null. */
export function margen(venta: ValorDecimal, ganancia: ValorDecimal): string | null {
  const v = new Decimal(venta);
  if (v.isZero()) return null;
  return new Decimal(ganancia).div(v).times(100).toDecimalPlaces(1, Decimal.ROUND_HALF_UP).toFixed(1);
}
