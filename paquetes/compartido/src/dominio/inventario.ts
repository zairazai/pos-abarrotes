/** Decide de qué lotes sale lo vendido. Regla: primero se vende lo que caduca antes. */
import Decimal from 'decimal.js';
import type { Unidad } from '../esquemas/catalogo';
import { dinero, importePorPeso, importePorPieza, peso, type ValorDecimal } from './importe';

/** Lo que se necesita saber de un lote para repartir. */
export interface LoteDisponible {
  id: string;
  /** AAAA-MM-DD, o null si el producto no caduca. */
  caducidad: string | null;
  existencia: ValorDecimal;
  creadoEn: Date | string;
}

/** Cuánto se tomó de un lote. */
export interface Consumo {
  loteId: string;
  cantidad: Decimal;
}

const instante = (fecha: Date | string) => new Date(fecha).getTime();

/**
 * Orden para descontar: primero el que caduca antes (aunque ya haya caducado); si caducan el mismo
 * día, el lote más viejo; y al final los que no caducan.
 */
export function ordenarPorCaducidad<T extends LoteDisponible>(lotes: T[]): T[] {
  return [...lotes].sort((a, b) => {
    if (a.caducidad !== b.caducidad) {
      if (a.caducidad === null) return 1;
      if (b.caducidad === null) return -1;
      return a.caducidad < b.caducidad ? -1 : 1;
    }
    return instante(a.creadoEn) - instante(b.creadoEn);
  });
}

/**
 * Reparte lo vendido entre los lotes. Si no alcanza, la venta no se detiene (es regla: nunca se le
 * niega una venta al cliente) y lo que falta se resta del último lote, que queda en negativo hasta
 * que se ajuste con un conteo. Si no hay lotes, todo es faltante y quien llama decide dónde anotarlo.
 */
export function planDescuento(
  lotes: LoteDisponible[],
  cantidad: ValorDecimal,
): { consumos: Consumo[]; faltante: Decimal } {
  const total = peso(cantidad);
  if (total.lte(0)) throw new RangeError('La cantidad a descontar debe ser mayor a cero');

  const orden = ordenarPorCaducidad(lotes);
  const consumos: Consumo[] = [];
  let restante = total;
  for (const l of orden) {
    if (restante.isZero()) break;
    const disponible = Decimal.max(peso(l.existencia), 0);
    const tomar = Decimal.min(disponible, restante);
    if (tomar.gt(0)) {
      consumos.push({ loteId: l.id, cantidad: tomar });
      restante = restante.minus(tomar);
    }
  }

  const faltante = restante;
  const ultimo = orden.at(-1);
  if (faltante.gt(0) && ultimo) {
    const existente = consumos.find((c) => c.loteId === ultimo.id);
    if (existente) existente.cantidad = existente.cantidad.plus(faltante);
    else consumos.push({ loteId: ultimo.id, cantidad: faltante });
  }
  return { consumos, faltante };
}

/** Un renglón de una entrada de mercancía. */
export interface RenglonEntrada {
  unidad: Unidad;
  costo: ValorDecimal;
  cantidad: ValorDecimal;
}

/** Importe de cada renglón (cantidad por costo) y total de la entrada; las piezas van enteras. */
export function totalEntrada(renglones: RenglonEntrada[]): { importes: Decimal[]; total: Decimal } {
  if (renglones.length === 0) throw new RangeError('La entrada necesita al menos un producto');
  const importes = renglones.map((r) => {
    if (r.unidad === 'KG') return importePorPeso(r.costo, r.cantidad);
    const piezas = new Decimal(r.cantidad);
    if (!piezas.isInteger()) throw new RangeError('Las piezas deben ser un número entero');
    return importePorPieza(r.costo, piezas.toNumber());
  });
  return { importes, total: dinero(importes.reduce((s, i) => s.plus(i), new Decimal(0))) };
}

/** Regla: la nota del proveedor se paga completa o no se paga; el monto tiene que ser su total. */
export function revisarPagoNota(monto: ValorDecimal, total: ValorDecimal): Decimal {
  const pago = dinero(monto);
  if (!pago.eq(dinero(total))) {
    throw new RangeError(`El pago debe ser el total de la nota ($${dinero(total).toFixed(2)})`);
  }
  return pago;
}

/**
 * Lote que se sugiere para una merma o consumo: el primero que caduca y todavía tiene existencia.
 * Se puede elegir otro (por ejemplo, el del frasco que se rompió). Si no hay existencia, null.
 */
export function lotePropuesto<T extends LoteDisponible>(lotes: T[]): T | null {
  return ordenarPorCaducidad(lotes).find((l) => peso(l.existencia).gt(0)) ?? null;
}

/**
 * Revisa la cantidad de una merma o consumo: mayor a cero, piezas enteras y sin pasarse de lo que
 * tiene el lote, porque aquí sí no se permiten negativos.
 */
export function revisarSalida(unidad: Unidad, existenciaLote: ValorDecimal, cantidad: ValorDecimal): Decimal {
  const salida = peso(cantidad);
  if (salida.lte(0)) throw new RangeError('La cantidad debe ser mayor a cero');
  if (unidad === 'PIEZA' && !salida.isInteger())
    throw new RangeError('Las piezas deben ser un número entero');
  const existencia = peso(existenciaLote);
  if (salida.gt(existencia)) {
    throw new RangeError(`La cantidad supera la existencia del lote (${existencia.toFixed(2)})`);
  }
  return salida;
}

/** Lo que regresa planAjuste. */
export interface PlanAjuste {
  registrada: Decimal; // suma de los lotes antes del ajuste
  diferencia: Decimal; // contada - registrada
  /** Cuánto cambia cada lote (positivo suma, negativo resta). */
  cambios: Consumo[];
  /** Cantidad para un lote nuevo, si el producto no tenía lotes; si no, null. */
  loteNuevo: Decimal | null;
}

/**
 * Ajuste por conteo: deja la suma de los lotes igual a lo que se contó. Si ya coincide, no se toca
 * nada. Si no, los lotes negativos (de vender sin existencia) quedan en cero; lo que falte se descuenta
 * empezando por el lote que caduca primero y lo que sobre se suma al lote más nuevo.
 */
export function planAjuste(unidad: Unidad, lotes: LoteDisponible[], contada: ValorDecimal): PlanAjuste {
  const conteo = peso(contada);
  if (conteo.lt(0)) throw new RangeError('La existencia contada no puede ser negativa');
  if (unidad === 'PIEZA' && !conteo.isInteger())
    throw new RangeError('Las piezas deben ser un número entero');

  const registrada = lotes.reduce((s, l) => s.plus(peso(l.existencia)), new Decimal(0));
  const diferencia = conteo.minus(registrada);
  if (diferencia.isZero()) return { registrada, diferencia, cambios: [], loteNuevo: null };
  if (lotes.length === 0) return { registrada, diferencia, cambios: [], loteNuevo: conteo };

  const cambios: Consumo[] = [];
  const cambiar = (loteId: string, cantidad: Decimal) => {
    const existente = cambios.find((c) => c.loteId === loteId);
    if (existente) existente.cantidad = existente.cantidad.plus(cantidad);
    else cambios.push({ loteId, cantidad });
  };

  // Primero los negativos se dejan en cero; de ahí en adelante solo cuentan los lotes con existencia.
  const orden = ordenarPorCaducidad(lotes);
  for (const l of orden) if (peso(l.existencia).lt(0)) cambiar(l.id, peso(l.existencia).negated());
  const positivos = orden.filter((l) => peso(l.existencia).gt(0));
  let pendiente = conteo.minus(positivos.reduce((s, l) => s.plus(peso(l.existencia)), new Decimal(0)));

  if (pendiente.lt(0)) {
    for (const l of positivos) {
      if (pendiente.isZero()) break;
      const tomar = Decimal.min(peso(l.existencia), pendiente.negated());
      cambiar(l.id, tomar.negated());
      pendiente = pendiente.plus(tomar);
    }
  } else if (pendiente.gt(0)) {
    const reciente = [...lotes].sort((a, b) => instante(b.creadoEn) - instante(a.creadoEn))[0]!;
    cambiar(reciente.id, pendiente);
  }
  return { registrada, diferencia, cambios, loteNuevo: null };
}

/** Regla: un lote empieza a alertar 7 días antes de caducar. */
export const DIAS_ALERTA_CADUCIDAD = 7;

const DIA_MS = 24 * 60 * 60 * 1000;

/** Días de calendario de hoy a la caducidad (AAAA-MM-DD); negativo si ya caducó. */
export function diasParaCaducar(caducidad: string, hoy: string): number {
  // Se cuenta en UTC para que el cambio de horario no mueva el resultado.
  return Math.round((Date.parse(`${caducidad}T00:00:00Z`) - Date.parse(`${hoy}T00:00:00Z`)) / DIA_MS);
}

/**
 * Dice si un lote alerta por caducidad: tiene existencia y caduca en 7 días o menos, o ya caducó.
 * Los lotes "No aplica" nunca alertan.
 */
export function caducaPronto(lote: LoteDisponible, hoy: string): boolean {
  if (lote.caducidad === null || peso(lote.existencia).lte(0)) return false;
  return diasParaCaducar(lote.caducidad, hoy) <= DIAS_ALERTA_CADUCIDAD;
}

/** Regla: alerta cuando la existencia llega a la mínima (igual o menos). */
export function enExistenciaMinima(existencia: ValorDecimal, minima: ValorDecimal): boolean {
  return peso(existencia).lte(peso(minima));
}

/**
 * Resumen de la revisión diaria de caducidades: los lotes con existencia que caducan en 7 días o
 * menos y, de esos, los que ya caducaron. Los "No aplica" no cuentan.
 */
export function resumenCaducidad(
  lotes: LoteDisponible[],
  hoy: string,
): { porCaducar: number; caducados: number } {
  const alertan = lotes.filter((l) => caducaPronto(l, hoy));
  const caducados = alertan.filter((l) => diasParaCaducar(l.caducidad!, hoy) < 0).length;
  return { porCaducar: alertan.length - caducados, caducados };
}

/** Cuántas alertas hay de cada tipo; los lotes caducados no se cuentan entre los por caducar. */
export interface ConteoAlertas {
  minimo: number;
  porCaducar: number;
  caducados: number;
}

const cuantos = (n: number, singular: string, plural: string) => `${n} ${n === 1 ? singular : plural}`;

/**
 * Frase del resumen que se muestra y se lee en voz alta al abrir la caja, por ejemplo
 * "2 productos en existencia mínima, 1 lote por caducar y 1 lote caducado".
 */
export function fraseDeAlertas({ minimo, porCaducar, caducados }: ConteoAlertas): string {
  const partes = [
    minimo > 0 && cuantos(minimo, 'producto en existencia mínima', 'productos en existencia mínima'),
    porCaducar > 0 && cuantos(porCaducar, 'lote por caducar', 'lotes por caducar'),
    caducados > 0 && cuantos(caducados, 'lote caducado', 'lotes caducados'),
  ].filter((p): p is string => !!p);
  if (partes.length === 0) return 'Sin alertas de inventario';
  const ultima = partes.pop()!;
  return partes.length === 0 ? ultima : `${partes.join(', ')} y ${ultima}`;
}

/**
 * Dice si falta hacer la revisión del día: ya pasó la hora programada y hoy todavía no se hace. Las
 * horas van como "HH:MM" y los días como AAAA-MM-DD.
 */
export function revisionPendiente(
  ultimaRevision: string | null,
  hoy: string,
  horaActual: string,
  horaRevision: string,
): boolean {
  return horaActual >= horaRevision && ultimaRevision !== hoy;
}
