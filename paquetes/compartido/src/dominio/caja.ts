/** Cuentas de la caja: denominaciones, total de un conteo, efectivo esperado y cómo salió el arqueo. */
import Decimal from 'decimal.js';
import { dinero, type ValorDecimal } from './importe';

/**
 * Billetes y monedas que se cuentan en el arqueo y en el fondo del primer día. Llegan solo hasta
 * 50 centavos porque, con el redondeo del efectivo, nunca se da cambio en monedas más chicas.
 */
export const DENOMINACIONES = [
  { clave: 'B1000', valor: '1000.00', tipo: 'BILLETE' },
  { clave: 'B500', valor: '500.00', tipo: 'BILLETE' },
  { clave: 'B200', valor: '200.00', tipo: 'BILLETE' },
  { clave: 'B100', valor: '100.00', tipo: 'BILLETE' },
  { clave: 'B50', valor: '50.00', tipo: 'BILLETE' },
  { clave: 'B20', valor: '20.00', tipo: 'BILLETE' },
  { clave: 'M20', valor: '20.00', tipo: 'MONEDA' },
  { clave: 'M10', valor: '10.00', tipo: 'MONEDA' },
  { clave: 'M5', valor: '5.00', tipo: 'MONEDA' },
  { clave: 'M2', valor: '2.00', tipo: 'MONEDA' },
  { clave: 'M1', valor: '1.00', tipo: 'MONEDA' },
  { clave: 'M050', valor: '0.50', tipo: 'MONEDA' },
] as const;

export type ClaveDenominacion = (typeof DENOMINACIONES)[number]['clave'];
export const CLAVES_DENOMINACION = DENOMINACIONES.map((d) => d.clave) as ClaveDenominacion[];

/** Cuántas piezas hay de cada billete o moneda; lo que no se manda cuenta como cero. */
export type Conteo = Partial<Record<ClaveDenominacion, number>>;

/** Suma en pesos de todo lo contado. */
export function totalConteo(conteo: Conteo): Decimal {
  let total = new Decimal(0);
  for (const { clave, valor } of DENOMINACIONES) {
    const cantidad = conteo[clave] ?? 0;
    if (!Number.isInteger(cantidad) || cantidad < 0) {
      throw new RangeError(`La cantidad de ${clave} debe ser un entero mayor o igual a cero`);
    }
    total = total.plus(new Decimal(valor).times(cantidad));
  }
  return dinero(total);
}

/** Movimientos de efectivo que no son venta: retiros e ingresos, siempre con motivo. */
export const TIPOS_MOVIMIENTO = ['RETIRO', 'INGRESO'] as const;
export type TipoMovimiento = (typeof TIPOS_MOVIMIENTO)[number];

/** Todo lo que mueve efectivo: además de retiros e ingresos, las ventas, pagos a proveedor y reembolsos. */
export type TipoEfectivo = TipoMovimiento | 'VENTA' | 'PAGO_PROVEEDOR' | 'DEVOLUCION';

/**
 * Efectivo esperado: fondo inicial más ingresos y efectivo de ventas, menos retiros, pagos a
 * proveedor y reembolsos. Puede quedar negativo, porque los retiros no se comparan contra el esperado.
 */
export function efectivoEsperado(
  fondoInicial: ValorDecimal,
  movimientos: { tipo: TipoEfectivo; monto: ValorDecimal }[],
): Decimal {
  let esperado = dinero(fondoInicial);
  for (const m of movimientos) {
    const sale = m.tipo === 'RETIRO' || m.tipo === 'PAGO_PROVEEDOR' || m.tipo === 'DEVOLUCION';
    esperado = sale ? esperado.minus(dinero(m.monto)) : esperado.plus(dinero(m.monto));
  }
  return esperado;
}

/**
 * Regla: lo que sale de la caja (pago a proveedor o reembolso de una devolución) no puede ser más que
 * el efectivo esperado. `accion` completa el mensaje de error: "pagar" o "reembolsar".
 */
export function revisarEfectivoParaPago(monto: ValorDecimal, esperado: ValorDecimal, accion = 'pagar'): void {
  const pago = dinero(monto);
  const efectivo = dinero(esperado);
  if (pago.gt(efectivo)) {
    throw new RangeError(
      `En caja hay $${efectivo.toFixed(2)}; no alcanza para ${accion} $${pago.toFixed(2)}`,
    );
  }
}

export type ResultadoArqueo = 'CUADRA' | 'RECONTAR' | 'JUSTIFICAR';

/**
 * Cómo salió el arqueo. Regla: si no cuadra, se vuelve a contar y, si la diferencia sigue, el cierre
 * pide una justificación. La diferencia es lo contado menos lo esperado.
 */
export function evaluarArqueo(
  intento: 1 | 2,
  contado: ValorDecimal,
  esperado: ValorDecimal,
): { resultado: ResultadoArqueo; diferencia: Decimal } {
  if (intento !== 1 && intento !== 2) throw new RangeError('Solo se permite un reconteo');
  const diferencia = dinero(contado).minus(dinero(esperado));
  if (diferencia.isZero()) return { resultado: 'CUADRA', diferencia };
  return { resultado: intento === 1 ? 'RECONTAR' : 'JUSTIFICAR', diferencia };
}
