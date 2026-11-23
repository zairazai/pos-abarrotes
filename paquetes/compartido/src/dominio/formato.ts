/** Formato de dinero y limpieza de textos para que las búsquedas encuentren con o sin acentos. */
import { dinero, type ValorDecimal } from './importe';

/** Deja un monto como $1,234.50. */
export function formatoMoneda(valor: ValorDecimal): string {
  const monto = dinero(valor);
  const [enteros, centavos] = monto.abs().toFixed(2).split('.');
  const conMiles = enteros!.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${monto.isNegative() ? '-' : ''}$${conMiles}.${centavos}`;
}

/** Texto en minúsculas, sin acentos y con espacios simples, para comparar nombres al buscar. */
export function normalizarTexto(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}
