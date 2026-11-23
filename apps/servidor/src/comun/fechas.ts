/**
 * Fechas con la hora de la tienda. La base guarda los instantes en UTC, pero "la caja de hoy" o "el
 * mismo día" dependen de la hora de Sinaloa (en la tarde, en Mazatlán, en UTC ya es otro día).
 */

/** Zona horaria de la tienda. */
export const ZONA_HORARIA = 'America/Mazatlan';

// Se usa 'en-CA' porque ese formato escribe la fecha como AAAA-MM-DD, justo lo que se necesita.
const formatoDia = new Intl.DateTimeFormat('en-CA', {
  timeZone: ZONA_HORARIA,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Día en la tienda, por ejemplo "2026-10-17". */
export function fechaLocal(instante: Date): string {
  return formatoDia.format(instante);
}

const formatoHora = new Intl.DateTimeFormat('en-GB', {
  timeZone: ZONA_HORARIA,
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** Hora en la tienda, por ejemplo "06:30". */
export function horaLocal(instante: Date): string {
  return formatoHora.format(instante);
}

/** Diferencia de la tienda con UTC en ese momento, por ejemplo "-07:00". */
function desfase(instante: Date): string {
  const nombre = new Intl.DateTimeFormat('en-US', { timeZone: ZONA_HORARIA, timeZoneName: 'longOffset' })
    .formatToParts(instante)
    .find((p) => p.type === 'timeZoneName')!.value;
  return nombre === 'GMT' ? '+00:00' : nombre.replace('GMT', '');
}

/** Instante exacto de un día y una hora de la tienda. */
function enHoraLocal(dia: string, hora: string): Date {
  const aproximado = new Date(`${dia}T12:00:00Z`); // mediodía, solo para sacar el desfase
  return new Date(`${dia}T${hora}${desfase(aproximado)}`);
}

/** Primer instante del día en la tienda (00:00:00). */
export function inicioDelDia(dia: string): Date {
  return enHoraLocal(dia, '00:00:00.000');
}

/** Último instante del día en la tienda (23:59:59.999). */
export function finDelDia(dia: string): Date {
  return enHoraLocal(dia, '23:59:59.999');
}
