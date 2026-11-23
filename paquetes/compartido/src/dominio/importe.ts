/**
 * Dinero y peso siempre con 2 decimales. Se usa Decimal y no number porque con number se pierden
 * centavos en las sumas. Aquí también está el importe de un renglón.
 */
import Decimal from 'decimal.js';

/** Puede llegar como texto ("18.50"), número o Decimal. */
export type ValorDecimal = Decimal.Value;

/** Monto con 2 decimales, redondeado al centavo. */
export function dinero(valor: ValorDecimal): Decimal {
  return new Decimal(valor).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

/** Peso en kilos, con 2 decimales. */
export function peso(valor: ValorDecimal): Decimal {
  return new Decimal(valor).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

/** Importe por pieza: precio por cantidad. */
export function importePorPieza(precio: ValorDecimal, cantidad: number): Decimal {
  if (!Number.isInteger(cantidad) || cantidad < 1) {
    throw new RangeError('La cantidad de piezas debe ser entera y mayor a cero');
  }
  return dinero(new Decimal(precio).times(cantidad));
}

/** Importe a granel: precio del kilo por lo que pesó, al centavo. */
export function importePorPeso(precioKg: ValorDecimal, pesoKg: ValorDecimal): Decimal {
  const kg = peso(pesoKg);
  if (kg.lte(0)) throw new RangeError('El peso debe ser mayor a cero');
  return dinero(new Decimal(precioKg).times(kg));
}
