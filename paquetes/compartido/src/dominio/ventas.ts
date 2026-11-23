/** Cuentas de una venta: importes, subtotal, promociones, descuento a mano y total, con precios de catálogo. */
import Decimal from 'decimal.js';
import type { Unidad } from '../esquemas/catalogo';
import { dinero, importePorPeso, importePorPieza, type ValorDecimal } from './importe';
import { descuentoPromocion, type ReglaPromocion } from './promociones';

/** Descuento que pone el Dueño a mano: en pesos o en porcentaje. */
export interface DescuentoManual {
  tipo: 'MONTO' | 'PORCENTAJE';
  valor: ValorDecimal;
}

export interface RenglonACalcular {
  /** Precio que tiene hoy el catálogo. */
  precio: ValorDecimal;
  unidad: Unidad;
  /** Piezas o kilos. */
  cantidad: ValorDecimal;
  /** Promoción vigente del producto, si tiene; se aplica sola. */
  promocion?: ReglaPromocion;
  descuento?: DescuentoManual;
}

export interface VentaCalculada {
  renglones: { importe: Decimal; descuentoPromocion: Decimal; descuentoManual: Decimal }[];
  subtotal: Decimal;
  /** Todo lo que descontaron las promociones. */
  ahorroPromociones: Decimal;
  /** Todo lo que se descontó a mano, por renglón y a la venta completa. */
  descuentoManual: Decimal;
  total: Decimal;
}

function montoDescuento(base: Decimal, descuento: DescuentoManual): Decimal {
  const valor = new Decimal(descuento.valor);
  if (valor.lte(0)) throw new RangeError('El descuento debe ser mayor a cero');
  if (descuento.tipo === 'PORCENTAJE' && valor.gt(100)) {
    throw new RangeError('El porcentaje de descuento no puede pasar de 100');
  }
  const monto = descuento.tipo === 'MONTO' ? dinero(valor) : dinero(base.times(valor).dividedBy(100));
  if (monto.gt(base)) {
    throw new RangeError(`El descuento de ${monto.toFixed(2)} excede el importe de ${base.toFixed(2)}`);
  }
  return monto;
}

/**
 * Importes y total de una venta. Primero se resta la promoción de cada renglón; luego el descuento a
 * mano, que puede ir por renglón o a toda la venta (el de la venta se aplica después del de los
 * renglones). El total puede quedar en cero, pero nunca en negativo.
 */
export function calcularVenta(
  renglones: RenglonACalcular[],
  descuentoVenta?: DescuentoManual,
): VentaCalculada {
  if (renglones.length === 0) throw new RangeError('La venta necesita al menos un producto');

  const calculados = renglones.map((r) => {
    let importe: Decimal;
    if (r.unidad === 'PIEZA') {
      const piezas = new Decimal(r.cantidad);
      if (!piezas.isInteger()) throw new RangeError('Las piezas deben ser un número entero');
      importe = importePorPieza(r.precio, piezas.toNumber());
    } else {
      importe = importePorPeso(r.precio, r.cantidad);
    }
    const promocion = r.promocion
      ? Decimal.min(descuentoPromocion({ precio: r.precio, cantidad: r.cantidad }, r.promocion), importe)
      : new Decimal(0);
    const base = importe.minus(promocion);
    const descuentoManual = r.descuento ? montoDescuento(base, r.descuento) : new Decimal(0);
    return { importe, descuentoPromocion: promocion, descuentoManual };
  });

  const subtotal = calculados.reduce((s, r) => s.plus(r.importe), new Decimal(0));
  const ahorroPromociones = calculados.reduce((s, r) => s.plus(r.descuentoPromocion), new Decimal(0));
  const descuentoRenglones = calculados.reduce((s, r) => s.plus(r.descuentoManual), new Decimal(0));
  const descuentoGeneral = descuentoVenta
    ? montoDescuento(subtotal.minus(ahorroPromociones).minus(descuentoRenglones), descuentoVenta)
    : new Decimal(0);
  const descuentoManual = descuentoRenglones.plus(descuentoGeneral);
  return {
    renglones: calculados,
    subtotal,
    ahorroPromociones,
    descuentoManual,
    total: subtotal.minus(ahorroPromociones).minus(descuentoManual),
  };
}
