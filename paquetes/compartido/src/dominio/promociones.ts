/** Cuentas de las promociones (mayoreo, 2x1/3x2 y precio especial), su estado y sus revisiones. */
import Decimal from 'decimal.js';
import type { Unidad } from '../esquemas/catalogo';
import { dinero, type ValorDecimal } from './importe';

/** Los tipos de promoción que hay. */
export type ReglaPromocion =
  | { tipo: 'MAYOREO'; cantidadMinima: ValorDecimal; precio: ValorDecimal }
  | { tipo: 'NXM'; lleva: number; paga: number }
  | { tipo: 'PRECIO_ESPECIAL'; precio: ValorDecimal };

export interface RenglonPromocion {
  /** Precio normal por pieza o por kilo. */
  precio: ValorDecimal;
  /** Piezas o kilos del renglón. */
  cantidad: ValorDecimal;
}

const CERO = new Decimal(0);

/** Cuánto descuenta una promoción vigente a un renglón; nunca da negativo. */
export function descuentoPromocion(renglon: RenglonPromocion, regla: ReglaPromocion): Decimal {
  const precio = new Decimal(renglon.precio);
  const cantidad = new Decimal(renglon.cantidad);

  switch (regla.tipo) {
    case 'MAYOREO': {
      if (cantidad.lt(regla.cantidadMinima)) return CERO;
      return dinero(Decimal.max(precio.minus(regla.precio), CERO).times(cantidad));
    }
    case 'NXM': {
      const grupos = cantidad.dividedToIntegerBy(regla.lleva);
      return dinero(grupos.times(regla.lleva - regla.paga).times(precio));
    }
    case 'PRECIO_ESPECIAL':
      return dinero(Decimal.max(precio.minus(regla.precio), CERO).times(cantidad));
  }
}

export type EstadoPromocion = 'PROGRAMADA' | 'ACTIVA' | 'VENCIDA';

/** Estado según las fechas (AAAA-MM-DD, días completos y con la hora de la tienda). */
export function estadoPromocion(inicio: string, fin: string, hoy: string): EstadoPromocion {
  if (hoy < inicio) return 'PROGRAMADA';
  return hoy <= fin ? 'ACTIVA' : 'VENCIDA';
}

/**
 * Revisa una promoción nueva contra su producto: el precio de mayoreo o especial tiene que ser menor
 * al normal, el mayoreo es de más de una unidad (piezas enteras), el NxM solo va por pieza y ninguna
 * puede empezar antes de hoy.
 */
export function revisarPromocion(
  regla: ReglaPromocion,
  producto: { precio: ValorDecimal; unidad: Unidad },
  inicio: string,
  hoy: string,
): void {
  if (inicio < hoy) throw new RangeError('La promoción no puede empezar antes de hoy');
  const normal = dinero(producto.precio);
  if (regla.tipo === 'NXM') {
    if (producto.unidad !== 'PIEZA') throw new RangeError('El NxM solo aplica a productos por pieza');
    return;
  }
  if (dinero(regla.precio).gte(normal)) {
    throw new RangeError(`El precio de la promoción debe ser menor al precio normal (${normal.toFixed(2)})`);
  }
  if (regla.tipo === 'MAYOREO') {
    const minima = new Decimal(regla.cantidadMinima);
    if (minima.lte(1)) throw new RangeError('La cantidad mínima de mayoreo debe ser mayor a 1');
    if (producto.unidad === 'PIEZA' && !minima.isInteger()) {
      throw new RangeError('Las piezas deben ser un número entero');
    }
  }
}
