/**
 * Módulo reportes: los 8 reportes del Dueño, calculados en el momento de consultar.
 * - Lee las tablas de los demás módulos, pero solo para consultar: es la única excepción a que cada
 *   módulo toque solo sus tablas, porque los reportes cruzan todas las áreas y no cambian nada.
 * - El costo de cada unidad es el de la nota con la que llegó su lote; los lotes sin nota (datos de
 *   ejemplo, ajustes y faltantes) usan el costo actual del producto.
 * - La exportación a PDF y Excel reusa generar(): la API guarda el pedido, el worker hace el archivo
 *   (reportes.archivos.ts) y le avisa a quien lo pidió. Los archivos se guardan 30 días.
 *   La entidad está en reportes.tablas.ts.
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Router } from 'express';
import { LessThan } from 'typeorm';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import type { Queue } from 'bullmq';
import { z } from 'zod';
import {
  Decimal,
  dinero,
  esquemaConsultaExportaciones,
  esquemaConsultaReporte,
  esquemaExportacion,
  esquemaExportacionNueva,
  esquemaId,
  esquemaReporte,
  esquemaTipoReporte,
  gananciaDeRenglon,
  margen,
  periodoReporte,
  type CantidadConCosto,
  type ConsultaExportaciones,
  type ConsultaReporte,
  type Exportacion,
  type ExportacionNueva,
  type FormatoExportacion,
  type Reporte,
  type ReporteCancelaciones,
  type ReporteCortes,
  type ReporteEmpleados,
  type ReporteGanancia,
  type ReporteInventario,
  type ReporteMasVendidos,
  type ReporteMermas,
  type ReporteVentas,
  type TipoReporte,
} from '@pos/compartido';
import { documentar } from '../../comun/documentar';
import { Conflicto, NoEncontrado, ReglaDeNegocio } from '../../comun/errores';
import { fechaLocal, finDelDia, inicioDelDia } from '../../comun/fechas';
import { paginacion, responder } from '../../comun/respuesta';
import { autenticar, autorizar } from '../../comun/seguridad';
import { sesionDe } from '../../comun/sesion';
import { datos, validar } from '../../comun/validar';
import { configuracion } from '../../config';
import { fuenteDatos } from '../../infraestructura/base-datos/fuente';
import { crearCola } from '../../infraestructura/colas';
import { ConfiguracionServicio } from '../configuracion/configuracion';
import { generarArchivoReporte } from './reportes.archivos';
import { ExportacionEntidad } from './reportes.tablas';

/** Cuántos productos salen en los más y menos vendidos. */
export const PRODUCTOS_EN_RANKING = 10;

/** Periodo ya resuelto: los días y los instantes de inicio y fin en la hora de la tienda. */
interface Periodo {
  desde: string;
  hasta: string;
  inicio: Date;
  fin: Date;
}

// Costo de un lote: el de su nota de entrada o, si no tiene, el actual del producto.
const COSTO_LOTE = 'COALESCE(ed.costo_unitario, p.costo)';

const cero = () => new Decimal(0);
const suma = (valores: Decimal.Value[]) => valores.reduce<Decimal>((t, v) => t.plus(v), cero());
const texto = (valor: Decimal.Value) => dinero(valor).toFixed(2);

/** Lo vendido de un producto en el periodo, ya sin lo devuelto. */
interface Vendido {
  productoId: string;
  nombre: string;
  unidad: 'PIEZA' | 'KG';
  cantidad: Decimal;
  venta: Decimal;
  costo: Decimal;
}

/** Periodo de la consulta; si no tiene sentido (desde después de hasta, más de 366 días), 422. */
function resolverPeriodo(consulta: ConsultaReporte): Periodo {
  try {
    const { desde, hasta } = periodoReporte(consulta.desde, consulta.hasta, fechaLocal(new Date()));
    return { desde, hasta, inicio: inicioDelDia(desde), fin: finDelDia(hasta) };
  } catch (error) {
    if (error instanceof RangeError) throw new ReglaDeNegocio(error.message);
    throw error;
  }
}

// --- Exportación ---

export const COLA_REPORTES = 'reportes';
/** Días que se guardan los archivos exportados. */
export const DIAS_CONSERVAR_EXPORTACIONES = 30;

let cola: Queue | null = null;

/** Forma la exportación en la cola con 3 intentos; el id evita que entre dos veces. */
export async function publicarExportacion(id: string): Promise<void> {
  cola ??= crearCola(COLA_REPORTES);
  await cola.add('exportar', { exportacionId: id }, { jobId: id });
}

export async function cerrarColaDeReportes(): Promise<void> {
  await cola?.close();
  cola = null;
}

const EXTENSIONES: Record<FormatoExportacion, string> = { PDF: 'pdf', EXCEL: 'xlsx' };
const rutaExportacion = (archivo: string) => join(configuracion.reportesCarpeta, archivo);

// --- Reglas ---

/**
 * La API apunta el pedido y el worker hace el archivo, para no frenar la caja. El archivo se escribe
 * primero como temporal y solo al terminar recibe su nombre de verdad.
 */
export class ExportacionesServicio {
  private exportaciones = fuenteDatos.getRepository(ExportacionEntidad);
  private reportes = new ReportesServicio();

  async pedir(tipo: TipoReporte, datos: ExportacionNueva, usuarioId: string): Promise<ExportacionEntidad> {
    // El inventario valorizado siempre es al momento.
    const { desde, hasta } = tipo === 'inventario' ? resolverPeriodo({}) : resolverPeriodo(datos);
    const id = randomUUID();
    const exportacion = this.exportaciones.create({
      id,
      tipo,
      formato: datos.formato,
      desde,
      hasta,
      estado: 'PENDIENTE',
      // Por ejemplo reporte-ventas_2026-10-01_2026-10-17_9f2c1a3b.pdf
      archivo: `reporte-${tipo}_${desde}_${hasta}_${id.slice(0, 8)}.${EXTENSIONES[datos.formato]}`,
      bytes: null,
      error: null,
      usuarioId,
      creadoEn: new Date(),
      terminadoEn: null,
    });
    await this.exportaciones.insert(exportacion);
    publicarExportacion(id).catch((error: Error) => {
      console.warn(`Exportación ${id} sin encolar; el worker la recuperará (${error.message})`);
    });
    return exportacion;
  }

  /** Lo corre el worker. Si falla, avienta el error para que BullMQ lo reintente. */
  async generar(id: string): Promise<ExportacionEntidad> {
    const exportacion = await this.exportaciones.findOneByOrFail({ id });
    if (exportacion.estado !== 'PENDIENTE') return exportacion;

    const reporte = await this.reportes.generar(exportacion.tipo, exportacion);
    const { nombre } = await new ConfiguracionServicio().consultar();
    const contenido = await generarArchivoReporte(reporte, exportacion.formato, {
      tienda: nombre,
      generadoEn: new Date(),
    });

    const final = rutaExportacion(exportacion.archivo);
    const temporal = `${final}.parcial`;
    try {
      await mkdir(configuracion.reportesCarpeta, { recursive: true });
      await writeFile(temporal, contenido);
      await rename(temporal, final);
    } catch (error) {
      await rm(temporal, { force: true });
      throw error;
    }
    Object.assign(exportacion, {
      estado: 'LISTO',
      bytes: String(contenido.length),
      terminadoEn: new Date(),
    });
    await this.exportaciones.save(exportacion);
    await this.rotar();
    return exportacion;
  }

  /** Se acabaron los intentos: queda FALLIDO con el motivo y el Dueño la vuelve a pedir. */
  async marcarFallido(id: string, motivo: string): Promise<void> {
    await this.exportaciones.update(
      { id, estado: 'PENDIENTE' },
      { estado: 'FALLIDO', error: motivo.slice(0, 300), terminadoEn: new Date() },
    );
  }

  /** Borra los archivos de más de 30 días; la fila se queda, con disponible: false. */
  async rotar(): Promise<string[]> {
    const limite = new Date(Date.now() - DIAS_CONSERVAR_EXPORTACIONES * 86_400_000);
    const viejas = await this.exportaciones.findBy({ estado: 'LISTO', creadoEn: LessThan(limite) });
    for (const e of viejas) await rm(rutaExportacion(e.archivo), { force: true });
    return viejas.map((e) => e.archivo);
  }

  pendientes(): Promise<ExportacionEntidad[]> {
    return this.exportaciones.findBy({ estado: 'PENDIENTE' });
  }

  pedido(id: string): Promise<ExportacionEntidad | null> {
    return this.exportaciones.findOneBy({ id });
  }

  /** Exportaciones de la más nueva a la más vieja. */
  async listar(
    consulta: ConsultaExportaciones,
  ): Promise<{ exportaciones: ExportacionEntidad[]; total: number }> {
    const [exportaciones, total] = await this.exportaciones.findAndCount({
      order: { creadoEn: 'DESC' },
      skip: (consulta.page - 1) * consulta.limit,
      take: consulta.limit,
    });
    return { exportaciones, total };
  }

  /** Ruta del archivo para descargarlo; avisa si todavía no está, si falló o si ya se borró. */
  async archivo(id: string): Promise<{ ruta: string; exportacion: ExportacionEntidad }> {
    const exportacion = await this.exportaciones.findOneBy({ id });
    if (!exportacion) throw new NoEncontrado('La exportación no existe');
    if (exportacion.estado === 'PENDIENTE') {
      throw new Conflicto('El archivo todavía se está generando; se avisará cuando esté listo');
    }
    if (exportacion.estado === 'FALLIDO') {
      throw new Conflicto(`No se pudo generar el archivo (${exportacion.error}); pídalo de nuevo`);
    }
    const ruta = rutaExportacion(exportacion.archivo);
    if (!existsSync(ruta)) {
      throw new NoEncontrado(
        `El archivo ya se borró: se guardan ${DIAS_CONSERVAR_EXPORTACIONES} días; pídalo de nuevo`,
      );
    }
    return { ruta, exportacion };
  }
}

/** Exportación en el formato de la respuesta. */
function aExportacion(e: ExportacionEntidad): Exportacion {
  return {
    id: e.id,
    tipo: e.tipo,
    formato: e.formato,
    desde: e.desde,
    hasta: e.hasta,
    estado: e.estado,
    archivo: e.archivo,
    bytes: e.bytes === null ? null : Number(e.bytes),
    error: e.error,
    disponible: e.estado === 'LISTO' && existsSync(rutaExportacion(e.archivo)),
    creadoEn: e.creadoEn.toISOString(),
    terminadoEn: e.terminadoEn?.toISOString() ?? null,
  };
}

const TIPOS_ARCHIVO: Record<FormatoExportacion, string> = {
  PDF: 'application/pdf',
  EXCEL: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

export class ReportesServicio {
  /** Calcula un reporte; lo usan tanto la consulta como la exportación. */
  async generar(tipo: TipoReporte, consulta: ConsultaReporte): Promise<Reporte> {
    const periodo = resolverPeriodo(consulta);
    switch (tipo) {
      case 'ventas':
        return this.ventas(periodo);
      case 'ganancia':
        return this.ganancia(periodo);
      case 'mas-vendidos':
        return this.masVendidos(periodo);
      case 'cortes':
        return this.cortes(periodo);
      case 'inventario':
        return this.inventario(); // siempre al momento
      case 'mermas':
        return this.mermas(periodo);
      case 'cancelaciones':
        return this.cancelaciones(periodo);
      case 'empleados':
        return this.empleados(periodo);
    }
  }

  /** Ventas por día: lo cobrado por forma de pago, lo devuelto y el neto. */
  private async ventas(p: Periodo): Promise<ReporteVentas> {
    const ventas: { fecha: Date; total: string; tarjeta: string; transferencia: string; saldo: string }[] =
      await fuenteDatos.query(
        `SELECT v.fecha, v.total_cobrado AS total,
           COALESCE(SUM(pg.monto) FILTER (WHERE pg.metodo = 'TARJETA'), 0) AS tarjeta,
           COALESCE(SUM(pg.monto) FILTER (WHERE pg.metodo = 'TRANSFERENCIA'), 0) AS transferencia,
           COALESCE(SUM(pg.monto) FILTER (WHERE pg.metodo = 'SALDO_FAVOR'), 0) AS saldo
         FROM venta v LEFT JOIN pago pg ON pg.venta_id = v.id
         WHERE v.estado = 'COBRADA' AND v.fecha BETWEEN $1 AND $2
         GROUP BY v.id`,
        [p.inicio, p.fin],
      );
    const devoluciones: { fecha: Date; importe: string }[] = await fuenteDatos.query(
      `SELECT d.fecha, SUM(dd.importe) AS importe
       FROM devolucion d JOIN devolucion_detalle dd ON dd.devolucion_id = d.id
       WHERE d.fecha BETWEEN $1 AND $2
       GROUP BY d.id`,
      [p.inicio, p.fin],
    );

    type Cifras = ReporteVentas['totales'];
    const nuevas = () => ({
      ventas: 0,
      total: cero(),
      tarjeta: cero(),
      transferencia: cero(),
      saldo: cero(),
      devuelto: cero(),
    });
    const porDia = new Map<string, ReturnType<typeof nuevas>>();
    const dia = (fecha: Date) => {
      const clave = fechaLocal(fecha);
      if (!porDia.has(clave)) porDia.set(clave, nuevas());
      return porDia.get(clave)!;
    };
    for (const v of ventas) {
      const d = dia(v.fecha);
      d.ventas += 1;
      d.total = d.total.plus(v.total);
      d.tarjeta = d.tarjeta.plus(v.tarjeta);
      d.transferencia = d.transferencia.plus(v.transferencia);
      d.saldo = d.saldo.plus(v.saldo);
    }
    for (const dv of devoluciones) dia(dv.fecha).devuelto = dia(dv.fecha).devuelto.plus(dv.importe);

    // Lo que no se pagó con tarjeta, transferencia ni saldo a favor se pagó en efectivo.
    const cifras = (c: ReturnType<typeof nuevas>): Cifras => ({
      ventas: c.ventas,
      total: texto(c.total),
      efectivo: texto(c.total.minus(c.tarjeta).minus(c.transferencia).minus(c.saldo)),
      tarjeta: texto(c.tarjeta),
      transferencia: texto(c.transferencia),
      saldoFavor: texto(c.saldo),
      devuelto: texto(c.devuelto),
      neto: texto(c.total.minus(c.devuelto)),
    });
    const dias = [...porDia.entries()].sort(([a], [b]) => a.localeCompare(b));
    const total = nuevas();
    for (const [, c] of dias) {
      total.ventas += c.ventas;
      for (const campo of ['total', 'tarjeta', 'transferencia', 'saldo', 'devuelto'] as const) {
        total[campo] = total[campo].plus(c[campo]);
      }
    }
    return {
      tipo: 'ventas',
      desde: p.desde,
      hasta: p.hasta,
      dias: dias.map(([fecha, c]) => ({ fecha, ...cifras(c) })),
      totales: cifras(total),
    };
  }

  /** Ganancia por producto: venta menos costo, del que más deja al que menos. */
  private async ganancia(p: Periodo): Promise<ReporteGanancia> {
    const vendidos = (await this.vendidos(p)).sort((a, b) =>
      b.venta.minus(b.costo).comparedTo(a.venta.minus(a.costo)),
    );
    const cifras = (venta: Decimal, costo: Decimal) => ({
      venta: texto(venta),
      costo: texto(costo),
      ganancia: texto(venta.minus(costo)),
      margen: margen(venta, venta.minus(costo)),
    });
    return {
      tipo: 'ganancia',
      desde: p.desde,
      hasta: p.hasta,
      productos: vendidos.map((v) => ({
        productoId: v.productoId,
        nombre: v.nombre,
        unidad: v.unidad,
        cantidad: v.cantidad.toFixed(2),
        ...cifras(v.venta, v.costo),
      })),
      totales: cifras(suma(vendidos.map((v) => v.venta)), suma(vendidos.map((v) => v.costo))),
    };
  }

  /** Los 10 más vendidos y los 10 menos vendidos por cantidad; en los menos entran los que no se vendieron. */
  private async masVendidos(p: Periodo): Promise<ReporteMasVendidos> {
    const vendidos = await this.vendidos(p);
    const activos: { id: string; nombre: string; unidad: 'PIEZA' | 'KG' }[] = await fuenteDatos.query(
      `SELECT id, nombre, unidad FROM producto WHERE activo`,
    );
    const porId = new Map(vendidos.map((v) => [v.productoId, v]));
    const fila = (v: Pick<Vendido, 'productoId' | 'nombre' | 'unidad' | 'cantidad' | 'venta'>) => ({
      productoId: v.productoId,
      nombre: v.nombre,
      unidad: v.unidad,
      cantidad: v.cantidad.toFixed(2),
      venta: texto(v.venta),
    });
    const porNombre = (a: { nombre: string }, b: { nombre: string }) =>
      a.nombre.localeCompare(b.nombre, 'es');

    const mas = vendidos
      .filter((v) => v.cantidad.gt(0))
      .sort((a, b) => b.cantidad.comparedTo(a.cantidad) || porNombre(a, b))
      .slice(0, PRODUCTOS_EN_RANKING);
    const menos = activos
      .map(
        (a) =>
          porId.get(a.id) ?? {
            productoId: a.id,
            nombre: a.nombre,
            unidad: a.unidad,
            cantidad: cero(),
            venta: cero(),
          },
      )
      .sort((a, b) => a.cantidad.comparedTo(b.cantidad) || porNombre(a, b))
      .slice(0, PRODUCTOS_EN_RANKING);
    return {
      tipo: 'mas-vendidos',
      desde: p.desde,
      hasta: p.hasta,
      masVendidos: mas.map(fila),
      menosVendidos: menos.map(fila),
    };
  }

  /** Cortes de caja: cada caja del periodo con su arqueo final. */
  private async cortes(p: Periodo): Promise<ReporteCortes> {
    const cajas: {
      fecha: string;
      estado: 'ABIERTA' | 'CERRADA';
      abierta_por: string;
      cerrada_por: string | null;
      fondo_inicial: string;
      efectivo_final: string | null;
      diferencia: string | null;
      justificacion: string | null;
    }[] = await fuenteDatos.query(
      `SELECT c.fecha::text AS fecha, c.estado, ua.nombre AS abierta_por, uc.nombre AS cerrada_por,
         c.fondo_inicial, c.efectivo_final, c.diferencia, c.justificacion
       FROM caja c
       JOIN usuario ua ON ua.id = c.abierta_por
       LEFT JOIN usuario uc ON uc.id = c.cerrada_por
       WHERE c.fecha BETWEEN $1 AND $2
       ORDER BY c.fecha`,
      [p.desde, p.hasta],
    );
    return {
      tipo: 'cortes',
      desde: p.desde,
      hasta: p.hasta,
      cajas: cajas.map((c) => ({
        fecha: c.fecha,
        estado: c.estado,
        abiertaPor: c.abierta_por,
        cerradaPor: c.cerrada_por,
        fondoInicial: texto(c.fondo_inicial),
        // diferencia = contado - esperado
        esperado:
          c.efectivo_final === null ? null : texto(new Decimal(c.efectivo_final).minus(c.diferencia ?? 0)),
        contado: c.efectivo_final === null ? null : texto(c.efectivo_final),
        diferencia: c.diferencia === null ? null : texto(c.diferencia),
        justificacion: c.justificacion,
      })),
      totales: { cajas: cajas.length, diferencia: texto(suma(cajas.map((c) => c.diferencia ?? 0))) },
    };
  }

  /** Inventario valorizado al momento: la existencia de cada producto activo por el costo de sus lotes. */
  private async inventario(): Promise<ReporteInventario> {
    const productos: {
      id: string;
      nombre: string;
      unidad: 'PIEZA' | 'KG';
      existencia: string;
      valor: string;
    }[] = await fuenteDatos.query(
      `SELECT p.id, p.nombre, p.unidad,
           COALESCE(SUM(l.existencia), 0) AS existencia,
           COALESCE(SUM(l.existencia * ${COSTO_LOTE}) FILTER (WHERE l.existencia > 0), 0) AS valor
         FROM producto p
         LEFT JOIN lote l ON l.producto_id = p.id
         LEFT JOIN entrada_detalle ed ON ed.lote_id = l.id
         WHERE p.activo
         GROUP BY p.id
         ORDER BY p.nombre`,
    );
    // Los lotes en negativo (de vender sin existencia) no suman valor.
    const hoy = fechaLocal(new Date());
    return {
      tipo: 'inventario',
      desde: hoy,
      hasta: hoy,
      productos: productos.map((x) => ({
        productoId: x.id,
        nombre: x.nombre,
        unidad: x.unidad,
        existencia: new Decimal(x.existencia).toFixed(2),
        valor: texto(x.valor),
      })),
      totales: { productos: productos.length, valor: texto(suma(productos.map((x) => dinero(x.valor)))) },
    };
  }

  /** Mermas y consumo propio con su costo. */
  private async mermas(p: Periodo): Promise<ReporteMermas> {
    const salidas: {
      fecha: Date;
      tipo: 'MERMA' | 'CONSUMO';
      producto_id: string;
      nombre: string;
      unidad: 'PIEZA' | 'KG';
      cantidad: string;
      costo: string;
      motivo: string;
      comentario: string | null;
      usuario: string;
    }[] = await fuenteDatos.query(
      `SELECT s.fecha, s.tipo, s.producto_id, p.nombre, p.unidad, s.cantidad,
         s.cantidad * ${COSTO_LOTE} AS costo, s.motivo, s.comentario, u.nombre AS usuario
       FROM salida s
       JOIN producto p ON p.id = s.producto_id
       JOIN usuario u ON u.id = s.usuario_id
       LEFT JOIN entrada_detalle ed ON ed.lote_id = s.lote_id
       WHERE s.fecha BETWEEN $1 AND $2
       ORDER BY s.fecha`,
      [p.inicio, p.fin],
    );
    const cifras = (tipo: 'MERMA' | 'CONSUMO') => {
      const deTipo = salidas.filter((s) => s.tipo === tipo);
      return { registros: deTipo.length, costo: texto(suma(deTipo.map((s) => dinero(s.costo)))) };
    };
    return {
      tipo: 'mermas',
      desde: p.desde,
      hasta: p.hasta,
      salidas: salidas.map((s) => ({
        fecha: s.fecha.toISOString(),
        tipo: s.tipo,
        productoId: s.producto_id,
        nombre: s.nombre,
        unidad: s.unidad,
        cantidad: new Decimal(s.cantidad).toFixed(2),
        costo: texto(s.costo),
        motivo: s.motivo,
        comentario: s.comentario,
        usuario: s.usuario,
      })),
      totales: { merma: cifras('MERMA'), consumo: cifras('CONSUMO') },
    };
  }

  /** Ventas canceladas sin cobrar y devoluciones. */
  private async cancelaciones(p: Periodo): Promise<ReporteCancelaciones> {
    const canceladas: {
      fecha: Date;
      motivo: 'EN_CURSO' | 'CIERRE';
      cancelada_por: string | null;
      renglones: number;
      total: string;
    }[] = await fuenteDatos.query(
      `SELECT v.fecha, v.motivo_cancelacion AS motivo, u.nombre AS cancelada_por, v.total,
         (SELECT count(*) FROM venta_detalle d WHERE d.venta_id = v.id)::int AS renglones
       FROM venta v LEFT JOIN usuario u ON u.id = v.cancelada_por
       WHERE v.estado = 'CANCELADA' AND v.fecha BETWEEN $1 AND $2
       ORDER BY v.fecha`,
      [p.inicio, p.fin],
    );
    const devoluciones: {
      fecha: Date;
      folio: number;
      tipo: 'PARCIAL' | 'TOTAL';
      motivo: string;
      forma_reembolso: 'EFECTIVO' | 'SALDO_FAVOR';
      importe: string;
      usuario: string;
    }[] = await fuenteDatos.query(
      `SELECT d.fecha, v.folio, d.tipo, d.motivo, d.forma_reembolso, SUM(dd.importe) AS importe,
         u.nombre AS usuario
       FROM devolucion d
       JOIN venta v ON v.id = d.venta_id
       JOIN usuario u ON u.id = d.usuario_id
       JOIN devolucion_detalle dd ON dd.devolucion_id = d.id
       WHERE d.fecha BETWEEN $1 AND $2
       GROUP BY d.id, v.folio, u.nombre
       ORDER BY d.fecha`,
      [p.inicio, p.fin],
    );
    return {
      tipo: 'cancelaciones',
      desde: p.desde,
      hasta: p.hasta,
      canceladas: canceladas.map((c) => ({
        fecha: c.fecha.toISOString(),
        motivo: c.motivo,
        canceladaPor: c.cancelada_por,
        renglones: c.renglones,
        total: texto(c.total),
      })),
      devoluciones: devoluciones.map((d) => ({
        fecha: d.fecha.toISOString(),
        folio: d.folio,
        tipo: d.tipo,
        motivo: d.motivo,
        formaReembolso: d.forma_reembolso,
        importe: texto(d.importe),
        usuario: d.usuario,
      })),
      totales: {
        canceladas: canceladas.length,
        totalCancelado: texto(suma(canceladas.map((c) => c.total))),
        devoluciones: devoluciones.length,
        totalDevuelto: texto(suma(devoluciones.map((d) => d.importe))),
      },
    };
  }

  /** Por usuario: ventas que cobró, cancelaciones que hizo y devoluciones que registró. */
  private async empleados(p: Periodo): Promise<ReporteEmpleados> {
    const filas: {
      id: string;
      nombre: string;
      ventas: number;
      total: string;
      cancelaciones: number;
      devoluciones: number;
      devuelto: string;
    }[] = await fuenteDatos.query(
      `SELECT u.id, u.nombre,
         (SELECT count(*) FROM venta v
           WHERE v.cobrada_por = u.id AND v.estado = 'COBRADA' AND v.fecha BETWEEN $1 AND $2)::int AS ventas,
         (SELECT COALESCE(SUM(v.total_cobrado), 0) FROM venta v
           WHERE v.cobrada_por = u.id AND v.estado = 'COBRADA' AND v.fecha BETWEEN $1 AND $2) AS total,
         (SELECT count(*) FROM venta v
           WHERE v.cancelada_por = u.id AND v.estado = 'CANCELADA' AND v.fecha BETWEEN $1 AND $2)::int
           AS cancelaciones,
         (SELECT count(*) FROM devolucion d
           WHERE d.usuario_id = u.id AND d.fecha BETWEEN $1 AND $2)::int AS devoluciones,
         (SELECT COALESCE(SUM(dd.importe), 0) FROM devolucion d
           JOIN devolucion_detalle dd ON dd.devolucion_id = d.id
           WHERE d.usuario_id = u.id AND d.fecha BETWEEN $1 AND $2) AS devuelto
       FROM usuario u
       ORDER BY u.nombre`,
      [p.inicio, p.fin],
    );
    return {
      tipo: 'empleados',
      desde: p.desde,
      hasta: p.hasta,
      empleados: filas
        .filter((f) => f.ventas + f.cancelaciones + f.devoluciones > 0)
        .map((f) => ({
          usuarioId: f.id,
          nombre: f.nombre,
          ventas: f.ventas,
          total: texto(f.total),
          cancelaciones: f.cancelaciones,
          devoluciones: f.devoluciones,
          devuelto: texto(f.devuelto),
        })),
    };
  }

  /**
   * Lo vendido por producto en el periodo, ya sin lo devuelto: cantidad, venta y costo de los lotes de
   * donde salió (menos el de los lotes a los que regresó).
   */
  private async vendidos(p: Periodo): Promise<Vendido[]> {
    const filtro = `v.estado = 'COBRADA' AND v.fecha BETWEEN $1 AND $2`;
    const renglones: {
      id: string;
      producto_id: string;
      nombre: string;
      unidad: 'PIEZA' | 'KG';
      cantidad: string;
      neto: string;
    }[] = await fuenteDatos.query(
      `SELECT d.id, d.producto_id, p.nombre, p.unidad, d.cantidad,
         d.importe - d.descuento_promocion - d.descuento_manual AS neto
       FROM venta_detalle d JOIN venta v ON v.id = d.venta_id JOIN producto p ON p.id = d.producto_id
       WHERE ${filtro}`,
      [p.inicio, p.fin],
    );
    const lotesVendidos: { renglon: string; cantidad: string; costo: string }[] = await fuenteDatos.query(
      `SELECT dl.venta_detalle_id AS renglon, dl.cantidad, ${COSTO_LOTE} AS costo
       FROM venta_detalle_lote dl
       JOIN venta_detalle d ON d.id = dl.venta_detalle_id
       JOIN venta v ON v.id = d.venta_id
       JOIN lote l ON l.id = dl.lote_id
       JOIN producto p ON p.id = l.producto_id
       LEFT JOIN entrada_detalle ed ON ed.lote_id = dl.lote_id
       WHERE ${filtro}`,
      [p.inicio, p.fin],
    );
    const devueltos: { renglon: string; cantidad: string; importe: string }[] = await fuenteDatos.query(
      `SELECT dd.venta_detalle_id AS renglon, SUM(dd.cantidad) AS cantidad, SUM(dd.importe) AS importe
       FROM devolucion_detalle dd
       JOIN venta_detalle d ON d.id = dd.venta_detalle_id
       JOIN venta v ON v.id = d.venta_id
       WHERE ${filtro}
       GROUP BY dd.venta_detalle_id`,
      [p.inicio, p.fin],
    );
    const lotesDevueltos: { renglon: string; cantidad: string; costo: string }[] = await fuenteDatos.query(
      `SELECT dd.venta_detalle_id AS renglon, xl.cantidad, ${COSTO_LOTE} AS costo
       FROM devolucion_lote xl
       JOIN devolucion_detalle dd ON dd.id = xl.devolucion_detalle_id
       JOIN venta_detalle d ON d.id = dd.venta_detalle_id
       JOIN venta v ON v.id = d.venta_id
       JOIN lote l ON l.id = xl.lote_id
       JOIN producto p ON p.id = l.producto_id
       LEFT JOIN entrada_detalle ed ON ed.lote_id = xl.lote_id
       WHERE ${filtro}`,
      [p.inicio, p.fin],
    );

    const agrupar = (filas: { renglon: string; cantidad: string; costo: string }[]) => {
      const mapa = new Map<string, CantidadConCosto[]>();
      for (const f of filas) mapa.set(f.renglon, [...(mapa.get(f.renglon) ?? []), f]);
      return mapa;
    };
    const vendidosPorRenglon = agrupar(lotesVendidos);
    const devueltosPorRenglon = agrupar(lotesDevueltos);
    const devolucion = new Map(devueltos.map((d) => [d.renglon, d]));

    const porProducto = new Map<string, Vendido>();
    for (const r of renglones) {
      const devuelto = devolucion.get(r.id);
      const { venta, costo } = gananciaDeRenglon({
        neto: r.neto,
        devuelto: devuelto?.importe ?? 0,
        vendidos: vendidosPorRenglon.get(r.id) ?? [],
        devueltos: devueltosPorRenglon.get(r.id) ?? [],
      });
      const cantidad = new Decimal(r.cantidad).minus(devuelto?.cantidad ?? 0);
      const actual = porProducto.get(r.producto_id);
      porProducto.set(r.producto_id, {
        productoId: r.producto_id,
        nombre: r.nombre,
        unidad: r.unidad,
        cantidad: (actual?.cantidad ?? cero()).plus(cantidad),
        venta: (actual?.venta ?? cero()).plus(venta),
        costo: (actual?.costo ?? cero()).plus(costo),
      });
    }
    return [...porProducto.values()];
  }
}

/** Dice si el reporte salió vacío en el periodo. */
function sinDatos(r: Reporte): boolean {
  switch (r.tipo) {
    case 'ventas':
      return r.dias.length === 0;
    case 'ganancia':
      return r.productos.length === 0;
    case 'mas-vendidos':
      return r.masVendidos.length === 0;
    case 'cortes':
      return r.cajas.length === 0;
    case 'inventario':
      return r.productos.length === 0;
    case 'mermas':
      return r.salidas.length === 0;
    case 'cancelaciones':
      return r.canceladas.length + r.devoluciones.length === 0;
    case 'empleados':
      return r.empleados.length === 0;
  }
}

// --- Rutas ---

export function rutasReportes(): Router {
  const router = Router();
  const servicio = new ReportesServicio();
  const exportaciones = new ExportacionesServicio();

  // Estas dos van antes de /reportes/:tipo, para que "exportaciones" y "archivos" no pasen por un tipo.

  // GET /reportes/exportaciones?page=1&limit=20
  router.get(
    '/reportes/exportaciones',
    autenticar,
    autorizar('reporte:exportar'),
    validar({ query: esquemaConsultaExportaciones }),
    async (req, res) => {
      const consulta = datos<ConsultaExportaciones>(req, 'query');
      const { exportaciones: lista, total } = await exportaciones.listar(consulta);
      const meta = paginacion(consulta.page, consulta.limit, total);
      responder(res, lista.map(aExportacion), `${total} exportaciones`, 200, meta);
    },
  );

  // GET /reportes/archivos/:id (descarga)
  router.get(
    '/reportes/archivos/:id',
    autenticar,
    autorizar('reporte:exportar'),
    validar({ params: esquemaId }),
    async (req, res) => {
      const { ruta, exportacion } = await exportaciones.archivo(datos<{ id: string }>(req, 'params').id);
      res
        .type(TIPOS_ARCHIVO[exportacion.formato])
        .set('Content-Disposition', `attachment; filename="${exportacion.archivo}"`)
        .sendFile(ruta);
    },
  );

  // POST /reportes/:tipo/exportaciones  { formato: 'PDF' | 'EXCEL', desde?, hasta? }
  router.post(
    '/reportes/:tipo/exportaciones',
    autenticar,
    autorizar('reporte:exportar'),
    validar({ params: esquemaTipoReporte, body: esquemaExportacionNueva }),
    async (req, res) => {
      const { tipo } = datos<{ tipo: TipoReporte }>(req, 'params');
      const exportacion = await exportaciones.pedir(
        tipo,
        datos<ExportacionNueva>(req, 'body'),
        sesionDe(req).usuarioId,
      );
      responder(
        res,
        aExportacion(exportacion),
        'Se está generando el archivo; se avisará cuando esté listo',
        202,
      );
    },
  );

  // GET /reportes/:tipo?desde=AAAA-MM-DD&hasta=AAAA-MM-DD (solo el Dueño)
  router.get(
    '/reportes/:tipo',
    autenticar,
    autorizar('reporte:consultar'),
    validar({ params: esquemaTipoReporte, query: esquemaConsultaReporte }),
    async (req, res) => {
      const { tipo } = datos<{ tipo: TipoReporte }>(req, 'params');
      const reporte = await servicio.generar(tipo, datos<ConsultaReporte>(req, 'query'));
      responder(res, reporte, sinDatos(reporte) ? 'Sin datos en el periodo' : `Reporte de ${tipo}`);
    },
  );

  return router;
}

// --- Swagger ---

export function documentarReportes(registro: OpenAPIRegistry): void {
  documentar(registro, [
    {
      metodo: 'get',
      ruta: '/reportes/:tipo',
      resumen:
        'Consultar un reporte: ventas, ganancia, más vendidos, cortes, inventario valorizado, mermas, cancelaciones o empleados',
      etiqueta: 'Reportes',
      permiso: 'reporte:consultar',
      params: esquemaTipoReporte,
      query: esquemaConsultaReporte,
      respuesta: esquemaReporte,
      errores: [422],
    },
    {
      metodo: 'post',
      ruta: '/reportes/:tipo/exportaciones',
      resumen: 'Exportar un reporte a PDF o Excel; el worker lo genera y avisa con reporte:listo',
      etiqueta: 'Reportes',
      permiso: 'reporte:exportar',
      params: esquemaTipoReporte,
      body: esquemaExportacionNueva,
      respuesta: esquemaExportacion,
      estado: 202,
      errores: [422],
    },
    {
      metodo: 'get',
      ruta: '/reportes/exportaciones',
      resumen: 'Consultar las exportaciones y su estado; los archivos se guardan 30 días',
      etiqueta: 'Reportes',
      permiso: 'reporte:exportar',
      query: esquemaConsultaExportaciones,
      respuesta: z.array(esquemaExportacion),
      paginada: true,
    },
    {
      metodo: 'get',
      ruta: '/reportes/archivos/:id',
      resumen: 'Descargar el PDF o el Excel de una exportación lista',
      etiqueta: 'Reportes',
      permiso: 'reporte:exportar',
      params: esquemaId,
      archivo: [TIPOS_ARCHIVO.PDF, TIPOS_ARCHIVO.EXCEL],
      errores: [404, 409],
    },
  ]);
}
