/**
 * Cuentas de las devoluciones: cuánto se pagó de verdad por cada renglón, qué se puede devolver
 * todavía y cuánto efectivo se regresa.
 */
import Decimal from 'decimal.js';
import type { Unidad } from '../esquemas/catalogo';
import { dinero, peso, type ValorDecimal } from './importe';
import { redondearEfectivo } from './pagos';

/**
 * Lo que realmente se pagó por cada renglón: su importe, menos su descuento, menos la parte que le
 * toca del descuento general (según cuánto pesa en la venta). Los centavos que sobren se los queda
 * el último renglón, así la suma cuadra exacto con el total.
 */
export function netoPorRenglon(
  renglones: { importe: ValorDecimal; descuento: ValorDecimal }[],
  descuentoGeneral: ValorDecimal,
): Decimal[] {
  const bases = renglones.map((r) => dinero(r.importe).minus(dinero(r.descuento)));
  const general = dinero(descuentoGeneral);
  const baseTotal = bases.reduce((s, b) => s.plus(b), new Decimal(0));
  if (general.isZero() || baseTotal.isZero()) return bases;

  let repartido = new Decimal(0);
  return bases.map((base, i) => {
    const parte =
      i === bases.length - 1 ? general.minus(repartido) : dinero(general.times(base).dividedBy(baseTotal));
    repartido = repartido.plus(parte);
    return base.minus(parte);
  });
}

/** Un renglón de la venta, con lo que ya se devolvió y lo que se pagó por él. */
export interface RenglonDevolvible {
  renglon: number;
  unidad: Unidad;
  vendida: ValorDecimal;
  devuelta: ValorDecimal;
  neto: ValorDecimal;
}

/**
 * Revisa lo que se quiere devolver y calcula cuánto se pagó por eso, en proporción a lo vendido.
 * `completa` dice si con esta devolución ya no queda nada más por devolver de la venta.
 */
export function planDevolucion(
  renglones: RenglonDevolvible[],
  seleccion: { renglon: number; cantidad: ValorDecimal }[],
): { montos: Decimal[]; monto: Decimal; completa: boolean } {
  const pendientes = new Map(renglones.map((r) => [r.renglon, peso(r.vendida).minus(peso(r.devuelta))]));
  const vistos = new Set<number>();

  const montos = seleccion.map((s) => {
    const r = renglones.find((x) => x.renglon === s.renglon);
    if (!r) throw new RangeError(`El renglón ${s.renglon} no es de esta venta`);
    if (vistos.has(s.renglon)) throw new RangeError(`El renglón ${s.renglon} debe ir una sola vez`);
    vistos.add(s.renglon);

    const cantidad = peso(s.cantidad);
    if (cantidad.lte(0)) throw new RangeError('La cantidad debe ser mayor a cero');
    if (r.unidad === 'PIEZA' && !cantidad.isInteger()) {
      throw new RangeError('Las piezas deben ser un número entero');
    }
    const pendiente = pendientes.get(s.renglon)!;
    if (cantidad.gt(pendiente)) {
      throw new RangeError(`Del renglón ${s.renglon} solo quedan ${pendiente.toFixed(2)} por devolver`);
    }
    pendientes.set(s.renglon, pendiente.minus(cantidad));
    return dinero(peso(r.neto).times(cantidad).dividedBy(peso(r.vendida)));
  });

  const monto = montos.reduce((s, m) => s.plus(m), new Decimal(0));
  const completa = [...pendientes.values()].every((p) => p.isZero());
  return { montos, monto, completa };
}

/**
 * Efectivo que se regresa: el monto redondeado a los 50 centavos de arriba, igual que en el cobro, sin
 * pasarse de lo que falta por reembolsar. Si se devuelve todo, se da exacto lo que falta.
 */
export function reembolsoEfectivo(monto: ValorDecimal, pendiente: ValorDecimal, completa: boolean): Decimal {
  if (completa) return dinero(pendiente);
  return Decimal.min(redondearEfectivo(monto), dinero(pendiente));
}

/**
 * Saldo a favor usado como primer pago de una venta nueva (cambio por producto): cubre lo que
 * alcance y el resto se paga normal; si sobra, se regresa en efectivo redondeado a los 50 centavos de
 * arriba, igual que los reembolsos.
 */
export function aplicarSaldo(
  total: ValorDecimal,
  saldo: ValorDecimal,
): { aplicado: Decimal; restante: Decimal; entrega: Decimal } {
  const aplicado = Decimal.min(dinero(saldo), dinero(total));
  const sobrante = dinero(saldo).minus(aplicado);
  return {
    aplicado,
    restante: dinero(total).minus(aplicado),
    entrega: sobrante.isZero() ? new Decimal(0) : redondearEfectivo(sobrante),
  };
}
