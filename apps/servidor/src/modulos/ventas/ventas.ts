/**
 * Módulo ventas: cobro, ventas canceladas y ticket.
 * La venta en curso vive en la interfaz; el servidor la recibe completa al cobrar y vuelve a calcular
 * todo con los precios del catálogo. En una sola transacción se guarda la venta con su folio, los
 * renglones y pagos, el descuento de inventario, el efectivo en la caja y la bitácora.
 * El PDF del ticket se hace en ventas.ticket.ts.
 */
import { randomUUID } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { IsNull, QueryFailedError, type EntityManager } from 'typeorm';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import {
  Decimal,
  aplicarSaldo,
  calcularVenta,
  esquemaClaveIdempotencia,
  esquemaCobro,
  esquemaFolio,
  esquemaVenta,
  esquemaVentaAbierta,
  esquemaVentaCobrada,
  formatoMoneda,
  liquidarPagos,
  textoResumenDia,
  tienePermiso,
  type Cobro,
  type DescuentoManual,
  type Rol,
  type Venta,
  type VentaAbierta,
  type VentaCobrada,
} from '@pos/compartido';
import { documentar } from '../../comun/documentar';
import {
  Conflicto,
  ErrorAplicacion,
  NoEncontrado,
  Prohibido,
  ReglaDeNegocio,
  SolicitudInvalida,
} from '../../comun/errores';
import { responder } from '../../comun/respuesta';
import { autenticar, autorizar } from '../../comun/seguridad';
import { sesionDe } from '../../comun/sesion';
import { emitir } from '../../comun/tiempo-real';
import { datos, validar } from '../../comun/validar';
import { fechaLocal } from '../../comun/fechas';
import { fuenteDatos } from '../../infraestructura/base-datos/fuente';
import { conTransaccion } from '../../infraestructura/base-datos/transaccion';
import { BitacoraServicio } from '../bitacora/bitacora';
import { CajaServicio, type ParticipanteCierre } from '../caja/caja';
import type { CajaEntidad } from '../caja/caja.tablas';
import { CatalogoServicio } from '../catalogo/catalogo';
import type { ProductoEntidad } from '../catalogo/catalogo.tablas';
import { ConfiguracionServicio } from '../configuracion/configuracion';
import { InventarioServicio } from '../inventario/inventario';
import { NotificacionesServicio } from '../notificaciones/notificaciones';
import { PromocionesServicio, type PromocionVigente } from '../promociones/promociones';
import { UsuariosServicio } from '../usuarios/usuarios';
import {
  PagoEntidad,
  SaldoFavorEntidad,
  VentaDetalleEntidad,
  VentaDetalleLoteEntidad,
  VentaEntidad,
} from './ventas.tablas';
import { generarTicketPdf, type DatosTicket } from './ventas.ticket';

/** Una venta con sus renglones y pagos. */
export interface DetalleVenta {
  venta: VentaEntidad;
  renglones: VentaDetalleEntidad[];
  pagos: PagoEntidad[];
}

/** Aviso de que un producto se vendió sin existencia suficiente (se permite, pero se avisa). */
export interface AvisoExistencia {
  productoId: string;
  nombre: string;
  faltante: Decimal;
}

/** Lo que regresa cobrar(). */
export interface ResultadoCobro {
  detalle: DetalleVenta;
  avisos: AvisoExistencia[];
  repetida: boolean; // esa clave ya se había cobrado
}

// --- Reglas ---
// Cumple ParticipanteCierre para que caja pueda cancelar las ventas abiertas al cerrar.

export class VentasServicio implements ParticipanteCierre {
  private ventas = fuenteDatos.getRepository(VentaEntidad);
  private detalles = fuenteDatos.getRepository(VentaDetalleEntidad);
  private pagos = fuenteDatos.getRepository(PagoEntidad);
  private catalogo = new CatalogoServicio();
  private inventario = new InventarioServicio();
  private promociones = new PromocionesServicio();
  private caja = new CajaServicio();
  private usuarios = new UsuariosServicio();
  private configuracion = new ConfiguracionServicio();
  private notificaciones = new NotificacionesServicio();
  private bitacora = new BitacoraServicio();

  /**
   * Cobro. "clave" es la Idempotency-Key que genera la interfaz para cada venta: si llega dos veces
   * (doble clic o reintento), no se cobra otra vez y se regresa la venta que ya existe.
   */
  async cobrar(datos: Cobro, clave: string, usuarioId: string, rol: Rol): Promise<ResultadoCobro> {
    const yaCobrada = await this.ventas.findOneBy({ claveIdempotencia: clave });
    if (yaCobrada) return { detalle: await this.detalle(yaCobrada), avisos: [], repetida: true };

    // Revisiones antes de cobrar

    // Regla: solo el Dueño cobra ventas con descuento.
    const conDescuento = !!datos.descuento || datos.renglones.some((r) => r.descuento);
    if (conDescuento && !tienePermiso(rol, 'venta:descuento')) {
      throw new Prohibido('Solo el Dueño aplica descuentos; el Dueño debe cobrar esta venta');
    }
    const caja = await this.caja.cajaAbiertaDeHoy();
    await this.validarIniciador(datos.iniciadaPor);
    const productos = await this.productos(datos.renglones, true);

    // El total se vuelve a calcular con los precios del catálogo y las promociones vigentes; lo que
    // mande la pantalla no se toma en cuenta.
    const vigentes = await this.promociones.vigentes();
    const promociones = productos.map((p) => vigentes.get(p.id));
    const calculo = this.calcular(productos, datos.renglones, datos.descuento, promociones);

    // Cambio por producto: el saldo a favor es el primer pago; si sobra, se regresa en efectivo.
    const saldo = datos.saldoFavorId ? await this.saldoDelDia(datos.saldoFavorId) : null;
    const conSaldo = aplicarSaldo(calculo.total, saldo?.monto ?? 0);

    // liquidarPagos revisa que alcance y calcula el redondeo y el cambio.
    const liquidacion = this.regla(() => liquidarPagos(conSaldo.restante, datos.pagos));
    if (!liquidacion.cubierto) {
      throw new ErrorAplicacion(
        422,
        'Operación no permitida por una regla de negocio',
        `Los pagos no cubren el total: faltan ${formatoMoneda(liquidacion.faltante)}`,
        undefined,
        { faltante: liquidacion.faltante.toFixed(2) },
      );
    }
    const efectivoRecibido = datos.pagos
      .filter((p) => p.metodo === 'EFECTIVO')
      .reduce((total, p) => total.plus(p.monto), new Decimal(0));

    const venta = this.ventas.create({
      id: randomUUID(),
      estado: 'COBRADA',
      cajaId: caja.id,
      iniciadaPor: datos.iniciadaPor,
      cobradaPor: usuarioId,
      canceladaPor: null,
      motivoCancelacion: null,
      claveIdempotencia: clave,
      subtotal: calculo.subtotal,
      ahorroPromociones: calculo.ahorroPromociones,
      descuentoManual: calculo.descuentoManual,
      total: calculo.total,
      redondeo: liquidacion.redondeo,
      totalCobrado: conSaldo.aplicado.plus(liquidacion.totalCobrado),
      cambio: liquidacion.cambio.plus(conSaldo.entrega),
      ticketEmitido: false,
      fecha: new Date(),
    });
    const renglones = this.renglones(venta.id, productos, datos.renglones, calculo.renglones, promociones);
    const pagos = datos.pagos.map((p) =>
      this.pagos.create({
        id: randomUUID(),
        ventaId: venta.id,
        metodo: p.metodo,
        monto: new Decimal(p.monto),
        referencia: p.referencia ?? null,
      }),
    );
    if (saldo && conSaldo.aplicado.gt(0)) {
      pagos.unshift(
        this.pagos.create({
          id: randomUUID(),
          ventaId: venta.id,
          metodo: 'SALDO_FAVOR',
          monto: conSaldo.aplicado,
          referencia: saldo.id,
        }),
      );
    }

    // Todo se guarda en una sola transacción

    try {
      return await conTransaccion(async (manager) => {
        // El folio sale de la secuencia venta_folio.
        const [{ folio }] = await manager.query(`SELECT nextval('venta_folio')::int AS folio`);
        venta.folio = folio;
        await manager.insert(VentaEntidad, venta);

        await manager.insert(VentaDetalleEntidad, renglones);
        if (pagos.length) await manager.insert(PagoEntidad, pagos);

        // Descuento de inventario por renglón y registro de los lotes que se usaron.
        const avisos: AvisoExistencia[] = [];
        for (const r of renglones) {
          const { consumos, faltante } = await this.inventario.descontarPorCaducidad(
            manager,
            r.productoId,
            r.cantidad,
          );
          await manager.insert(
            VentaDetalleLoteEntidad,
            consumos.map((c) => ({ ventaDetalleId: r.id, loteId: c.loteId, cantidad: c.cantidad })),
          );
          if (faltante.gt(0)) avisos.push({ productoId: r.productoId, nombre: r.nombre, faltante });
        }

        // Efectivo que queda en la caja: lo recibido menos el cambio.
        await this.caja.registrarEfectivoDeVenta(manager, {
          cajaId: caja.id,
          ventaId: venta.id,
          folio,
          monto: efectivoRecibido.minus(liquidacion.cambio),
          usuarioId,
        });

        if (saldo) {
          // Se marca como usado aquí, para que dos cobros al mismo tiempo no lo usen los dos.
          const uso = await manager.update(
            SaldoFavorEntidad,
            { id: saldo.id, ventaId: IsNull() },
            { ventaId: venta.id },
          );
          if (!uso.affected) throw new Conflicto('El saldo a favor ya se usó');
          // Lo que sobró del saldo sale de la caja como parte del reembolso de su devolución.
          if (conSaldo.entrega.gt(0)) {
            await this.caja.registrarReembolso(manager, {
              cajaId: caja.id,
              devolucionId: saldo.devolucionId,
              monto: conSaldo.entrega,
              motivo: `Diferencia del saldo a favor en el folio ${folio}`,
              usuarioId,
            });
          }
        }

        // Bitácora, con un registro de más si hubo descuento.
        await this.bitacora.registrar(
          {
            usuarioId,
            accion: 'VENTA_COBRADA',
            entidad: 'venta',
            entidadId: venta.id,
            despues: {
              folio,
              iniciadaPor: venta.iniciadaPor,
              total: venta.total.toFixed(2),
              totalCobrado: venta.totalCobrado.toFixed(2),
              ahorroPromociones: venta.ahorroPromociones.toFixed(2),
              pagos: pagos.map((p) => ({ metodo: p.metodo, monto: p.monto.toFixed(2) })),
            },
          },
          manager,
        );
        if (venta.descuentoManual.gt(0)) {
          await this.bitacora.registrar(
            {
              usuarioId,
              accion: 'VENTA_DESCUENTO',
              entidad: 'venta',
              entidadId: venta.id,
              despues: {
                folio,
                descuentoManual: venta.descuentoManual.toFixed(2),
                renglones: datos.renglones.filter((r) => r.descuento),
                venta: datos.descuento ?? null,
              },
            },
            manager,
          );
        }
        return { detalle: { venta, renglones, pagos }, avisos, repetida: false };
      });
    } catch (error) {
      // Dos peticiones al mismo tiempo con la misma clave: el índice único deja guardar solo una y a la
      // otra se le regresa la venta ya guardada.
      if (esDuplicado(error, 'clave_idempotencia')) {
        const registrada = await this.ventas.findOneByOrFail({ claveIdempotencia: clave });
        return { detalle: await this.detalle(registrada), avisos: [], repetida: true };
      }
      throw error;
    }
  }

  /**
   * Resumen del día para el Dueño al cerrar la caja. La ganancia es aproximada: usa el costo actual de
   * cada producto, porque la venta no guarda el costo de ese momento.
   */
  async alCerrarCaja(caja: CajaEntidad): Promise<void> {
    const [ventas] = await fuenteDatos.query(
      `SELECT count(*)::int AS cuantas, coalesce(sum(total), 0) AS total
       FROM venta WHERE caja_id = $1 AND estado = 'COBRADA'`,
      [caja.id],
    );
    const [costos] = await fuenteDatos.query(
      `SELECT coalesce(sum(d.cantidad * p.costo), 0) AS costo
       FROM venta_detalle d
       JOIN venta v ON v.id = d.venta_id
       JOIN producto p ON p.id = d.producto_id
       WHERE v.caja_id = $1 AND v.estado = 'COBRADA'`,
      [caja.id],
    );
    const [devoluciones] = await fuenteDatos.query(
      // Lo devuelto, no solo el efectivo: un cambio por producto también cuenta.
      `SELECT coalesce(sum(d.importe), 0) AS total
       FROM devolucion_detalle d
       JOIN devolucion v ON v.id = d.devolucion_id
       WHERE v.caja_id = $1`,
      [caja.id],
    );
    await this.notificaciones.avisarAlDueno(
      `Resumen del ${caja.fecha}`,
      textoResumenDia({
        fecha: caja.fecha,
        ventas: ventas.cuantas,
        total: ventas.total,
        devoluciones: devoluciones.total,
        ganancia: new Decimal(ventas.total).minus(costos.costo),
        diferencia: caja.diferencia ?? 0,
        justificacion: caja.justificacion,
      }),
    );
  }

  /** Para devoluciones: crea el saldo a favor de un cambio por producto. */
  async crearSaldoFavor(
    manager: EntityManager,
    saldo: { devolucionId: string; monto: Decimal },
  ): Promise<SaldoFavorEntidad> {
    const nuevo = manager.create(SaldoFavorEntidad, {
      id: randomUUID(),
      devolucionId: saldo.devolucionId,
      monto: saldo.monto,
      fecha: new Date(),
      ventaId: null,
    });
    await manager.insert(SaldoFavorEntidad, nuevo);
    return nuevo;
  }

  /** Venta cancelada en pantalla sin cobrar. Regla: se guarda como constancia. */
  async cancelarEnCurso(datos: VentaAbierta, usuarioId: string): Promise<DetalleVenta> {
    const caja = await this.caja.cajaAbierta();
    await this.validarIniciador(datos.iniciadaPor);
    return conTransaccion((manager) => this.registrarCancelada(manager, caja.id, datos, usuarioId));
  }

  /** Venta cobrada por folio. */
  async consultar(folio: number): Promise<DetalleVenta> {
    return this.detalle(await this.cobradaPorFolio(folio));
  }

  /**
   * Ticket en PDF. La primera vez sale el original; las siguientes son copias y quedan en la bitácora
   * (es regla). Con folio 'ULTIMO' se reimprime el último.
   */
  async ticket(
    folio: number | 'ULTIMO',
    usuarioId: string,
  ): Promise<{ pdf: Buffer; folio: number; copia: boolean }> {
    const venta =
      folio === 'ULTIMO'
        ? await this.ventas.findOne({ where: { estado: 'COBRADA' }, order: { folio: 'DESC' } })
        : await this.cobradaPorFolio(folio);
    if (!venta) throw new NoEncontrado('Todavía no se ha emitido ningún ticket');

    // Se marca como emitido solo si no lo estaba: si se actualizó una fila es el original, si no, es
    // copia. Así, dos peticiones al mismo tiempo no se llevan las dos el original.
    const { affected } = await this.ventas.update(
      { id: venta.id, ticketEmitido: false },
      { ticketEmitido: true },
    );
    const copia = affected === 0;

    const pdf = await generarTicketPdf(await this.datosTicket(await this.detalle(venta), copia));
    if (copia) {
      await this.bitacora.registrar({
        usuarioId,
        accion: 'TICKET_REIMPRESO',
        entidad: 'venta',
        entidadId: venta.id,
        despues: { folio: venta.folio },
      });
    }
    return { pdf, folio: venta.folio!, copia };
  }

  /**
   * La llama caja al cerrar. Regla: las ventas que quedaron abiertas se cancelan a nombre del sistema,
   * dentro de la transacción del cierre.
   */
  async cancelarVentasAbiertas(
    manager: EntityManager,
    cajaId: string,
    ventas: VentaAbierta[],
  ): Promise<number> {
    for (const venta of ventas) {
      if (!(await this.usuarios.usuarioPorId(venta.iniciadaPor))) {
        throw new ReglaDeNegocio('Una de las ventas abiertas la inició un usuario que no existe');
      }
      await this.registrarCancelada(manager, cajaId, venta, null); // cancelada por el sistema
    }
    return ventas.length;
  }

  // Ayudantes de adentro

  /**
   * Guarda una venta cancelada, sin folio y sin tocar inventario ni efectivo. canceladaPor es null
   * cuando la cancela el sistema al cerrar la caja.
   */
  private async registrarCancelada(
    manager: EntityManager,
    cajaId: string,
    datos: VentaAbierta,
    canceladaPor: string | null,
  ): Promise<DetalleVenta> {
    const productos = await this.productos(datos.renglones, false);
    const calculo = this.calcular(productos, datos.renglones);
    const venta = this.ventas.create({
      id: randomUUID(),
      folio: null,
      estado: 'CANCELADA',
      cajaId,
      iniciadaPor: datos.iniciadaPor,
      cobradaPor: null,
      canceladaPor,
      motivoCancelacion: canceladaPor ? 'EN_CURSO' : 'CIERRE',
      claveIdempotencia: null,
      subtotal: calculo.subtotal,
      ahorroPromociones: new Decimal(0),
      descuentoManual: new Decimal(0),
      total: calculo.total,
      redondeo: new Decimal(0),
      totalCobrado: new Decimal(0),
      cambio: new Decimal(0),
      ticketEmitido: false,
      fecha: new Date(),
    });
    const renglones = this.renglones(venta.id, productos, datos.renglones, calculo.renglones);
    await manager.insert(VentaEntidad, venta);
    await manager.insert(VentaDetalleEntidad, renglones);
    await this.bitacora.registrar(
      {
        usuarioId: canceladaPor,
        accion: 'VENTA_CANCELADA',
        entidad: 'venta',
        entidadId: venta.id,
        despues: {
          motivo: venta.motivoCancelacion,
          iniciadaPor: venta.iniciadaPor,
          total: venta.total.toFixed(2),
          renglones: renglones.length,
        },
      },
      manager,
    );
    return { venta, renglones, pagos: [] };
  }

  /** Venta con sus renglones y pagos (las dos consultas en paralelo). */
  private async detalle(venta: VentaEntidad): Promise<DetalleVenta> {
    const [renglones, pagos] = await Promise.all([
      this.detalles.find({ where: { ventaId: venta.id }, order: { renglon: 'ASC' } }),
      this.pagos.find({ where: { ventaId: venta.id } }),
    ]);
    return { venta, renglones, pagos };
  }

  private async cobradaPorFolio(folio: number): Promise<VentaEntidad> {
    const venta = await this.ventas.findOneBy({ folio, estado: 'COBRADA' });
    if (!venta) throw new NoEncontrado(`No existe una venta cobrada con el folio ${folio}`);
    return venta;
  }

  /** Saldo a favor sin usar y del día. Regla: no se guarda para otro día. */
  private async saldoDelDia(id: string): Promise<SaldoFavorEntidad> {
    const saldo = await fuenteDatos.getRepository(SaldoFavorEntidad).findOneBy({ id });
    if (!saldo) throw new NoEncontrado('El saldo a favor no existe');
    if (saldo.ventaId) throw new Conflicto('El saldo a favor ya se usó');
    const dia = fechaLocal(saldo.fecha);
    if (dia !== fechaLocal(new Date())) {
      throw new ReglaDeNegocio(`El saldo a favor era del ${dia}; no se guarda para otro día`);
    }
    return saldo;
  }

  /** Quien empezó la venta tiene que ser un usuario activo, aunque la cobre otro. */
  private async validarIniciador(id: string): Promise<void> {
    if (!(await this.usuarios.usuarioActivoPorId(id))) {
      throw new ReglaDeNegocio('Quien inició la venta no es un usuario activo');
    }
  }

  /**
   * Productos de la venta en el catálogo. Regla: al cobrar tienen que estar activos; al cancelar basta
   * con que existan.
   */
  private async productos(
    renglones: { productoId: string }[],
    soloActivos: boolean,
  ): Promise<ProductoEntidad[]> {
    return Promise.all(
      renglones.map(async ({ productoId }) => {
        const producto = soloActivos
          ? await this.catalogo.productoActivoPorId(productoId)
          : await this.catalogo.productoPorId(productoId);
        if (producto) return producto;
        // Se distingue entre desactivado y que no existe, para dar un mensaje claro.
        const desactivado = soloActivos ? await this.catalogo.productoPorId(productoId) : null;
        throw new ReglaDeNegocio(
          desactivado
            ? `El producto ${desactivado.nombre} está desactivado y ya no se vende`
            : 'Uno de los productos de la venta no existe',
        );
      }),
    );
  }

  /** Importes, subtotal, promociones, descuento y total con precios del catálogo (usa calcularVenta). */
  private calcular(
    productos: ProductoEntidad[],
    renglones: { cantidad: string; descuento?: DescuentoManual }[],
    descuentoVenta?: DescuentoManual,
    promociones: (PromocionVigente | undefined)[] = [],
  ) {
    return this.regla(() =>
      calcularVenta(
        renglones.map((r, i) => ({
          precio: productos[i]!.precio,
          unidad: productos[i]!.unidad,
          cantidad: r.cantidad,
          promocion: promociones[i]?.regla,
          descuento: r.descuento,
        })),
        descuentoVenta,
      ),
    );
  }

  /** Filas de venta_detalle con el nombre y el precio de ese momento. */
  private renglones(
    ventaId: string,
    productos: ProductoEntidad[],
    renglones: { cantidad: string }[],
    calculados: { importe: Decimal; descuentoPromocion: Decimal; descuentoManual: Decimal }[],
    promociones: (PromocionVigente | undefined)[] = [],
  ): VentaDetalleEntidad[] {
    return renglones.map((r, i) =>
      this.detalles.create({
        id: randomUUID(),
        ventaId,
        renglon: i + 1,
        productoId: productos[i]!.id,
        nombre: productos[i]!.nombre,
        unidad: productos[i]!.unidad,
        precio: productos[i]!.precio,
        cantidad: new Decimal(r.cantidad),
        importe: calculados[i]!.importe,
        descuentoPromocion: calculados[i]!.descuentoPromocion,
        // Solo si de verdad descontó; por ejemplo, un mayoreo sin la cantidad mínima no cuenta.
        promocionId: calculados[i]!.descuentoPromocion.gt(0) ? (promociones[i]?.id ?? null) : null,
        descuentoManual: calculados[i]!.descuentoManual,
      }),
    );
  }

  /**
   * Las funciones del paquete compartido lanzan RangeError (por ejemplo, un descuento mayor al importe);
   * aquí se convierte en ReglaDeNegocio (422).
   */
  private regla<T>(calculo: () => T): T {
    try {
      return calculo();
    } catch (error) {
      if (error instanceof RangeError) throw new ReglaDeNegocio(error.message);
      throw error;
    }
  }

  /** Datos que necesita ventas.ticket.ts. */
  private async datosTicket(d: DetalleVenta, copia: boolean): Promise<DatosTicket> {
    const tienda = await this.configuracion.datosTienda();
    const cajero = await this.usuarios.usuarioPorId(d.venta.cobradaPor!);
    return {
      tienda,
      folio: d.venta.folio!,
      fecha: d.venta.fecha,
      cajero: cajero?.nombre ?? 'Cajero',
      renglones: d.renglones.map((r) => ({
        nombre: r.nombre,
        cantidad: r.unidad === 'PIEZA' ? r.cantidad.toFixed(0) : r.cantidad.toFixed(2),
        unidad: r.unidad,
        precio: r.precio.toFixed(2),
        importe: r.importe.toFixed(2),
        descuento: r.descuentoPromocion.toFixed(2),
      })),
      descuentoManual: d.venta.descuentoManual.toFixed(2),
      total: d.venta.total.toFixed(2),
      redondeo: d.venta.redondeo.toFixed(2),
      pagos: d.pagos.map((p) => ({
        metodo: p.metodo,
        monto: p.monto.toFixed(2),
        referencia: p.referencia ?? undefined,
      })),
      cambio: d.venta.cambio.toFixed(2),
      ahorroPromociones: d.venta.ahorroPromociones.toFixed(2),
      enlaceBot: tienda.enlaceBot || undefined,
      copia,
    };
  }
}

/** Dice si el error es de valor repetido (23505) en la restricción indicada. */
function esDuplicado(error: unknown, columna: string): boolean {
  if (!(error instanceof QueryFailedError)) return false;
  const { code, constraint } = error.driverError as { code?: string; constraint?: string };
  return code === '23505' && !!constraint?.includes(columna);
}

// --- Rutas ---
// Dueño y Empleado cobran, cancelan y reimprimen; lo del descuento lo revisa cobrar().

export function rutasVentas(): Router {
  const router = Router();
  const servicio = new VentasServicio();

  // POST /ventas (cabecera Idempotency-Key): 201 si se cobró, 200 si ya estaba cobrada.
  router.post(
    '/ventas',
    autenticar,
    autorizar('venta:cobrar'),
    validar({ body: esquemaCobro }),
    async (req, res) => {
      const { usuarioId, rol } = sesionDe(req);
      const { detalle, avisos, repetida } = await servicio.cobrar(
        datos<Cobro>(req, 'body'),
        claveIdempotencia(req),
        usuarioId,
        rol,
      );
      const mensaje = repetida
        ? `La venta con folio ${detalle.venta.folio} ya estaba cobrada`
        : `Venta cobrada con folio ${detalle.venta.folio}`;
      // La venta bajó existencias, así que las alertas pueden cambiar.
      if (!repetida) emitir('alertas:actualizadas');
      responder(res, aVentaCobrada(detalle, avisos), mensaje, repetida ? 200 : 201);
    },
  );

  // POST /ventas/canceladas
  router.post(
    '/ventas/canceladas',
    autenticar,
    autorizar('venta:cancelar_en_curso'),
    validar({ body: esquemaVentaAbierta }),
    async (req, res) => {
      const detalle = await servicio.cancelarEnCurso(
        datos<VentaAbierta>(req, 'body'),
        sesionDe(req).usuarioId,
      );
      responder(res, aVenta(detalle), 'Venta cancelada', 201);
    },
  );

  // GET /ventas/ultimo/ticket.pdf. Va antes de /ventas/:folio para que "ultimo" no se confunda con un folio.
  router.get('/ventas/ultimo/ticket.pdf', autenticar, autorizar('ticket:reimprimir'), async (req, res) => {
    enviarPdf(res, await servicio.ticket('ULTIMO', sesionDe(req).usuarioId));
  });

  // GET /ventas/:folio
  router.get(
    '/ventas/:folio',
    autenticar,
    autorizar('ticket:reimprimir'),
    validar({ params: esquemaFolio }),
    async (req, res) => {
      const { folio } = datos<{ folio: number }>(req, 'params');
      responder(res, aVenta(await servicio.consultar(folio)), `Venta con folio ${folio}`);
    },
  );

  // GET /ventas/:folio/ticket.pdf
  router.get(
    '/ventas/:folio/ticket.pdf',
    autenticar,
    autorizar('ticket:reimprimir'),
    validar({ params: esquemaFolio }),
    async (req, res) => {
      const { folio } = datos<{ folio: number }>(req, 'params');
      enviarPdf(res, await servicio.ticket(folio, sesionDe(req).usuarioId));
    },
  );

  return router;
}

/** Lee la cabecera Idempotency-Key (UUID); si falta o no es válida, 400. */
function claveIdempotencia(req: Request): string {
  const resultado = esquemaClaveIdempotencia.safeParse(req.get('Idempotency-Key'));
  if (!resultado.success) {
    throw new SolicitudInvalida('Falta la cabecera Idempotency-Key o no es válida', [
      { campo: 'headers.idempotency-key', mensaje: 'Debe ser un UUID único para esta venta' },
    ]);
  }
  return resultado.data;
}

/** Manda el PDF para abrirse en el navegador; X-Ticket-Copia dice si es copia. */
function enviarPdf(res: Response, ticket: { pdf: Buffer; folio: number; copia: boolean }): void {
  const nombre = `ticket-${ticket.folio}${ticket.copia ? '-copia' : ''}.pdf`;
  res
    .status(200)
    .type('application/pdf')
    .set('Content-Disposition', `inline; filename="${nombre}"`)
    .set('X-Ticket-Copia', String(ticket.copia))
    .send(ticket.pdf);
}

// Formato de las respuestas: montos con 2 decimales y fechas ISO.

function aVenta(d: DetalleVenta): Venta {
  const v = d.venta;
  return {
    id: v.id,
    folio: v.folio,
    estado: v.estado,
    fecha: v.fecha.toISOString(),
    iniciadaPor: v.iniciadaPor,
    cobradaPor: v.cobradaPor,
    canceladaPor: v.canceladaPor,
    motivoCancelacion: v.motivoCancelacion,
    renglones: d.renglones.map((r) => ({
      productoId: r.productoId,
      nombre: r.nombre,
      unidad: r.unidad,
      precio: r.precio.toFixed(2),
      cantidad: r.cantidad.toFixed(2),
      importe: r.importe.toFixed(2),
      descuentoPromocion: r.descuentoPromocion.toFixed(2),
      descuentoManual: r.descuentoManual.toFixed(2),
    })),
    subtotal: v.subtotal.toFixed(2),
    ahorroPromociones: v.ahorroPromociones.toFixed(2),
    descuentoManual: v.descuentoManual.toFixed(2),
    total: v.total.toFixed(2),
    redondeo: v.redondeo.toFixed(2),
    totalCobrado: v.totalCobrado.toFixed(2),
    cambio: v.cambio.toFixed(2),
    pagos: d.pagos.map((p) => ({ metodo: p.metodo, monto: p.monto.toFixed(2), referencia: p.referencia })),
  };
}

/** aVenta más los avisos de existencia. */
function aVentaCobrada(d: DetalleVenta, avisos: AvisoExistencia[]): VentaCobrada {
  return {
    ...aVenta(d),
    avisos: avisos.map((a) => ({
      productoId: a.productoId,
      nombre: a.nombre,
      faltante: a.faltante.toFixed(2),
    })),
  };
}

// --- Swagger ---

export function documentarVentas(registro: OpenAPIRegistry): void {
  const etiqueta = 'Ventas';
  documentar(registro, [
    {
      metodo: 'post',
      ruta: '/ventas',
      resumen:
        'Cobrar una venta: se recalcula el total, se redondea el efectivo, se descuentan lotes y se registra el efectivo en la caja. Si la Idempotency-Key ya se cobró, devuelve esa venta con 200',
      etiqueta,
      permiso: 'venta:cobrar',
      cabeceras: z.object({ 'Idempotency-Key': esquemaClaveIdempotencia }),
      body: esquemaCobro,
      respuesta: esquemaVentaCobrada,
      estado: 201,
      errores: [409, 422],
    },
    {
      metodo: 'post',
      ruta: '/ventas/canceladas',
      resumen: 'Registrar una venta que se canceló sin cobrar',
      etiqueta,
      permiso: 'venta:cancelar_en_curso',
      body: esquemaVentaAbierta,
      respuesta: esquemaVenta,
      estado: 201,
      errores: [422],
    },
    {
      metodo: 'get',
      ruta: '/ventas/ultimo/ticket.pdf',
      resumen: 'Reimprimir el último ticket',
      etiqueta,
      permiso: 'ticket:reimprimir',
      archivo: 'application/pdf',
      errores: [404],
    },
    {
      metodo: 'get',
      ruta: '/ventas/:folio',
      resumen: 'Consultar una venta cobrada por su folio',
      etiqueta,
      permiso: 'ticket:reimprimir',
      params: esquemaFolio,
      respuesta: esquemaVenta,
      errores: [404],
    },
    {
      metodo: 'get',
      ruta: '/ventas/:folio/ticket.pdf',
      resumen: 'Ticket en PDF de 80 mm con QR; la primera vez es el original y después sale como copia',
      etiqueta,
      permiso: 'ticket:reimprimir',
      params: esquemaFolio,
      archivo: 'application/pdf',
      errores: [404],
    },
  ]);
}
