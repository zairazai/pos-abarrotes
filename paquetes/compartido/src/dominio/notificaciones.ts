/** Textos de lo que se envía: promociones a los clientes y el resumen del día al Dueño. */
import { dinero, type ValorDecimal } from './importe';
import type { ReglaPromocion } from './promociones';

const pesos = (monto: ValorDecimal) => `$${dinero(monto).toFixed(2)}`;

// Cada promoción dice cómo darse de baja. Como el POS no tiene dirección pública, el correo no
// trae enlace: la baja se pide por el bot o en la tienda.
export const PIE_BAJA_CORREO =
  'Para dejar de recibir promociones escribe /baja al bot de la tienda o pídelo en la caja.';
export const PIE_BAJA_TELEGRAM = 'Para dejar de recibir promociones escribe /baja.';

function condiciones(regla: ReglaPromocion): string {
  if (regla.tipo === 'NXM') return `${regla.lleva}x${regla.paga}`;
  if (regla.tipo === 'MAYOREO') return `desde ${regla.cantidadMinima} a ${pesos(regla.precio)}`;
  return `a ${pesos(regla.precio)}`;
}

export function textoPromocion(p: {
  tienda: string;
  producto: string;
  regla: ReglaPromocion;
  inicio: string;
  fin: string;
}): string {
  return `${p.tienda}: ${p.producto} ${condiciones(p.regla)}. Del ${p.inicio} al ${p.fin}.`;
}

export function textoResumenDia(r: {
  fecha: string;
  ventas: number;
  total: ValorDecimal;
  devoluciones: ValorDecimal;
  ganancia: ValorDecimal;
  diferencia: ValorDecimal;
  justificacion: string | null;
}): string {
  const resumen =
    `Resumen del ${r.fecha}: ${r.ventas} ventas por ${pesos(r.total)}. ` +
    `Devoluciones: ${pesos(r.devoluciones)}. Ganancia aproximada: ${pesos(r.ganancia)}.`;
  const diferencia = dinero(r.diferencia);
  if (diferencia.isZero()) return resumen;
  const monto = `${diferencia.isNegative() ? '-' : ''}${pesos(diferencia.abs())}`;
  return `${resumen} Diferencia del arqueo: ${monto}${r.justificacion ? ` (${r.justificacion})` : ''}.`;
}
