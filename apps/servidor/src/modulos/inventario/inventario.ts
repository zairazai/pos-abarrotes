/**
 * Módulo inventario: entradas de mercancía con su pago al proveedor, mermas y consumo propio, ajustes
 * por conteo, existencias con sus lotes, alertas y el descuento de lo vendido. Catálogo lo usa para
 * las existencias y ventas para descontar al cobrar.
 * Las entidades están en inventario.tablas.ts.
 */
import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { In, QueryFailedError, type EntityManager } from 'typeorm';
import { z } from 'zod';
import {
  caducaPronto,
  Decimal,
  diasParaCaducar,
  enExistenciaMinima,
  esquemaAjusteInventario,
  esquemaAjusteNuevo,
  esquemaAlertas,
  esquemaConsultaEntradas,
  esquemaEntrada,
  esquemaEntradaNueva,
  esquemaExistencias,
  esquemaId,
  esquemaPagoProveedor,
  esquemaSalidaInventario,
  esquemaSalidaNueva,
  fraseDeAlertas,
  lotePropuesto,
  ordenarPorCaducidad,
  planAjuste,
  planDescuento,
  resumenCaducidad,
  revisionPendiente,
  revisarPagoNota,
  revisarSalida,
  totalEntrada,
  type AjusteInventario,
  type AjusteNuevo,
  type Alertas,
  type ConsultaEntradas,
  type Consumo,
  type Entrada,
  type EntradaNueva,
  type Existencias,
  type PagoProveedor,
  type ResumenAlertas,
  type SalidaInventario,
  type SalidaNueva,
  type ValorDecimal,
} from '@pos/compartido';
import { documentar } from '../../comun/documentar';
import { Conflicto, NoEncontrado, ReglaDeNegocio } from '../../comun/errores';
import { fechaLocal, horaLocal } from '../../comun/fechas';
import { configuracion } from '../../config';
import { paginacion, responder } from '../../comun/respuesta';
import { autenticar, autorizar } from '../../comun/seguridad';
import { sesionDe } from '../../comun/sesion';
import { emitir } from '../../comun/tiempo-real';
import { datos, validar } from '../../comun/validar';
import { fuenteDatos } from '../../infraestructura/base-datos/fuente';
import { borrarCache, clavesProducto } from '../../infraestructura/cache';
import { conTransaccion } from '../../infraestructura/base-datos/transaccion';
import { BitacoraServicio } from '../bitacora/bitacora';
import { CajaServicio } from '../caja/caja';
import { CajaEntidad, MovimientoEfectivoEntidad } from '../caja/caja.tablas';
import { ProductoEntidad } from '../catalogo/catalogo.tablas';
import { ProveedoresServicio } from '../proveedores/proveedores';
import {
  AjusteEntidad,
  AjusteLoteEntidad,
  EjecucionTareaEntidad,
  EntradaDetalleEntidad,
  EntradaEntidad,
  LoteEntidad,
  SalidaEntidad,
} from './inventario.tablas';

/** Lo que regresa descontarPorCaducidad. */
export interface Descuento {
  /** Cuánto se tomó de cada lote; ventas lo guarda para saber de qué lote salió cada pieza. */
  consumos: Consumo[];
  /** Lo que se vendió sin tener existencia; 0 si alcanzó. */
  faltante: Decimal;
}

/** Entrada con sus renglones y los datos que se enseñan del proveedor y los productos. */
export interface DetalleEntrada {
  entrada: EntradaEntidad;
  proveedor: { id: string; nombre: string };
  renglones: EntradaDetalleEntidad[];
  productos: Map<string, ProductoEntidad>;
  pago: MovimientoEfectivoEntidad | null; // null si todavía no se paga
}

/** Salida registrada con el lote del que salió y su producto. */
export interface DetalleSalida {
  salida: SalidaEntidad;
  lote: LoteEntidad; // con la existencia que le quedó
  producto: ProductoEntidad;
}

/** Nombre de la revisión de caducidades en ejecucion_tarea. */
const TAREA_REVISION = 'REVISION_CADUCIDADES';

/** Resumen de una revisión diaria de caducidades. */
export type ResumenRevision = NonNullable<Alertas['ultimaRevision']>;

const aRevision = (e: EjecucionTareaEntidad): ResumenRevision => ({
  fecha: e.fecha,
  ejecutadaEn: e.ejecutadaEn.toISOString(),
  ...e.resultado,
});

/** Ajuste por conteo; si lo contado ya coincidía, ajuste es null y no hay lotes. */
export interface DetalleAjuste {
  ajuste: AjusteEntidad | null;
  producto: ProductoEntidad;
  registrada: Decimal;
  contada: Decimal;
  diferencia: Decimal;
  lotes: { loteId: string; cambio: Decimal; existencia: Decimal }[];
  usuarioId: string;
}

// --- Reglas ---

export class InventarioServicio {
  private lotes = fuenteDatos.getRepository(LoteEntidad);
  private entradas = fuenteDatos.getRepository(EntradaEntidad);
  private detalles = fuenteDatos.getRepository(EntradaDetalleEntidad);
  private productos = fuenteDatos.getRepository(ProductoEntidad);
  private movimientos = fuenteDatos.getRepository(MovimientoEfectivoEntidad);
  private proveedores = new ProveedoresServicio();
  private caja = new CajaServicio();
  private bitacora = new BitacoraServicio();

  /**
   * Entrada de mercancía. En una sola transacción se guarda la nota y se crea un lote por renglón con su
   * caducidad; además, el costo del producto pasa a ser el de esta entrada (son reglas de la tienda).
   * El pago va completo o no va: tiene que ser el total de la nota. Si la caja de hoy no está abierta o
   * no le alcanza el efectivo, la entrada se guarda sin pago y avisoPago dice por qué; se paga después.
   */
  async registrarEntrada(
    datos: EntradaNueva,
    usuarioId: string,
  ): Promise<{ detalle: DetalleEntrada; avisoPago: string | null }> {
    const proveedor = await this.proveedores.porId(datos.proveedorId);
    // Si el proveedor no existe, el Dueño lo da de alta primero y la nota se captura después.
    if (!proveedor)
      throw new ReglaDeNegocio('El proveedor no está registrado; el Dueño debe registrarlo primero');

    const repetida = await this.entradas
      .createQueryBuilder('e')
      .where('e.proveedor_id = :proveedorId', { proveedorId: proveedor.id })
      .andWhere('upper(e.folio_nota) = upper(:folio)', { folio: datos.folioNota })
      .getOne();
    if (repetida) throw new Conflicto(`La nota ${datos.folioNota} de ${proveedor.nombre} ya se registró`);

    const productos = await this.productosActivos(datos.renglones.map((r) => r.productoId));
    const lista = datos.renglones.map((r) => productos.get(r.productoId)!);
    const { importes, total } = this.regla(() =>
      totalEntrada(
        datos.renglones.map((r, i) => ({
          unidad: lista[i]!.unidad,
          costo: r.costoUnitario,
          cantidad: r.cantidad,
        })),
      ),
    );
    if (datos.pago) this.regla(() => revisarPagoNota(datos.pago!.monto, total));

    const ahora = new Date();
    const entrada = this.entradas.create({
      id: randomUUID(),
      proveedorId: proveedor.id,
      folioNota: datos.folioNota,
      usuarioId,
      fecha: ahora,
      total,
    });
    const lotes = datos.renglones.map((r) =>
      this.lotes.create({
        id: randomUUID(),
        productoId: r.productoId,
        caducidad: r.caducidad,
        existencia: new Decimal(r.cantidad),
        cantidadInicial: new Decimal(r.cantidad),
        origen: 'ENTRADA',
        creadoEn: ahora,
      }),
    );
    const renglones = datos.renglones.map((r, i) =>
      this.detalles.create({
        id: randomUUID(),
        entradaId: entrada.id,
        renglon: i + 1,
        productoId: r.productoId,
        cantidad: new Decimal(r.cantidad),
        costoUnitario: new Decimal(r.costoUnitario),
        importe: importes[i]!,
        caducidad: r.caducidad,
        loteId: lotes[i]!.id,
      }),
    );

    let caja: CajaEntidad | null = null;
    let avisoPago: string | null = null;
    // Sin la caja de hoy abierta, o sin efectivo suficiente, no se paga; pero la entrada sí se guarda,
    // para no perder la captura.
    if (datos.pago) {
      try {
        const abierta = await this.caja.cajaAbiertaDeHoy();
        await this.caja.revisarSalidaDeEfectivo(abierta, new Decimal(datos.pago.monto));
        caja = abierta;
      } catch (error) {
        if (!(error instanceof ReglaDeNegocio || error instanceof Conflicto)) throw error;
        avisoPago = error.message;
      }
    }
    let pago: MovimientoEfectivoEntidad | null = null;

    // Costo nuevo de cada producto: el del último renglón donde aparece.
    const costos = new Map<string, Decimal>();
    for (const r of renglones) costos.set(r.productoId, r.costoUnitario);

    try {
      await conTransaccion(async (manager) => {
        await manager.insert(EntradaEntidad, entrada);
        await manager.insert(LoteEntidad, lotes);
        await manager.insert(EntradaDetalleEntidad, renglones);
        for (const [productoId, costo] of costos) {
          await manager.update(ProductoEntidad, productoId, { costo, actualizadoEn: ahora });
        }
        await this.bitacora.registrar(
          {
            usuarioId,
            accion: 'ENTRADA_REGISTRADA',
            entidad: 'entrada',
            entidadId: entrada.id,
            antes: {
              costos: [...costos.keys()].map((id) => ({
                productoId: id,
                costo: productos.get(id)!.costo.toFixed(2),
              })),
            },
            despues: {
              proveedor: proveedor.nombre,
              folioNota: entrada.folioNota,
              total: total.toFixed(2),
              renglones: renglones.length,
              costos: [...costos].map(([id, costo]) => ({ productoId: id, costo: costo.toFixed(2) })),
              // Si se pidió pagar y no se pudo, aquí queda el porqué.
              pago: caja && datos.pago ? new Decimal(datos.pago.monto).toFixed(2) : null,
              sinPago: avisoPago,
            },
          },
          manager,
        );
        if (caja && datos.pago) {
          pago = await this.guardarPago(manager, caja, entrada, proveedor.nombre, datos.pago, usuarioId);
        }
      });
    } catch (error) {
      // Dos capturas al mismo tiempo de la misma nota: el índice único rechaza la segunda.
      if (esDuplicado(error, 'entrada_nota')) {
        throw new Conflicto(`La nota ${datos.folioNota} de ${proveedor.nombre} ya se registró`);
      }
      throw error;
    }
    // Cambió el costo: se borra de la caché del catálogo.
    await borrarCache(...[...costos.keys()].flatMap((id) => clavesProducto(productos.get(id)!)));

    return {
      detalle: {
        entrada,
        proveedor: { id: proveedor.id, nombre: proveedor.nombre },
        renglones,
        productos: new Map(lista.map((p) => [p.id, p])),
        pago,
      },
      avisoPago,
    };
  }

  /**
   * Pago después de una entrada que se guardó sin pago. Es el total de la nota, sale de la caja abierta
   * de hoy si le alcanza el efectivo, y cada entrada se paga una sola vez.
   */
  async pagarEntrada(entradaId: string, datos: PagoProveedor, usuarioId: string): Promise<DetalleEntrada> {
    const entrada = await this.entradas.findOneBy({ id: entradaId });
    if (!entrada) throw new NoEncontrado('La entrada no existe');
    const yaPagada = new Conflicto(`La nota ${entrada.folioNota} ya se pagó`);
    if (await this.movimientos.existsBy({ entradaId })) throw yaPagada;
    this.regla(() => revisarPagoNota(datos.monto, entrada.total));
    const caja = await this.caja.cajaAbiertaDeHoy();
    const proveedor = await this.proveedores.porId(entrada.proveedorId);

    try {
      await conTransaccion((manager) =>
        this.guardarPago(manager, caja, entrada, proveedor!.nombre, datos, usuarioId),
      );
    } catch (error) {
      // Dos pagos al mismo tiempo de la misma entrada: el índice único rechaza el segundo.
      if (esDuplicado(error, 'movimiento_efectivo_pago_entrada')) throw yaPagada;
      throw error;
    }
    return this.completar(entrada);
  }

  /**
   * Merma o consumo propio. Sale de un solo lote: el que se eligió o, si no se dice, el que caduca
   * primero y tiene existencia. La cantidad no puede pasarse de lo que hay en el lote. No hace falta
   * tener la caja abierta.
   */
  async registrarSalida(datos: SalidaNueva, usuarioId: string): Promise<DetalleSalida> {
    const producto = (await this.productosActivos([datos.productoId])).get(datos.productoId)!;

    return conTransaccion(async (manager) => {
      // El mismo candado por producto que en el cobro: la existencia del lote no cambia mientras se revisa.
      await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [producto.id]);
      const lotes = await manager.findBy(LoteEntidad, { productoId: producto.id });

      let lote: LoteEntidad | null;
      if (datos.loteId) {
        lote = lotes.find((l) => l.id === datos.loteId) ?? null;
        if (!lote) throw new ReglaDeNegocio('El lote no es de este producto');
      } else {
        lote = lotePropuesto(lotes);
        if (!lote) throw new ReglaDeNegocio(`${producto.nombre} no tiene existencia para dar de baja`);
      }
      const antes = lote.existencia;
      const cantidad = this.regla(() => revisarSalida(producto.unidad, antes, datos.cantidad));

      const salida = manager.create(SalidaEntidad, {
        id: randomUUID(),
        tipo: datos.tipo,
        productoId: producto.id,
        loteId: lote.id,
        cantidad,
        motivo: datos.motivo,
        comentario: datos.comentario ?? null,
        usuarioId,
        fecha: new Date(),
      });
      lote.existencia = antes.minus(cantidad);
      await manager.update(LoteEntidad, lote.id, { existencia: lote.existencia });
      await manager.insert(SalidaEntidad, salida);
      await this.bitacora.registrar(
        {
          usuarioId,
          accion: 'SALIDA_REGISTRADA',
          entidad: 'salida',
          entidadId: salida.id,
          antes: { existenciaLote: antes.toFixed(2) },
          despues: {
            tipo: salida.tipo,
            productoId: producto.id,
            loteId: lote.id,
            cantidad: cantidad.toFixed(2),
            motivo: salida.motivo,
            existenciaLote: lote.existencia.toFixed(2),
          },
        },
        manager,
      );
      return { salida, lote, producto };
    });
  }

  /**
   * Ajuste por conteo: la existencia queda igual a lo que se contó. El reparto entre lotes lo calcula
   * planAjuste del paquete compartido. Si lo contado ya coincide, no se apunta nada.
   */
  async registrarAjuste(datos: AjusteNuevo, usuarioId: string): Promise<DetalleAjuste> {
    const producto = (await this.productosActivos([datos.productoId])).get(datos.productoId)!;

    return conTransaccion(async (manager) => {
      // El mismo candado por producto que en el cobro, para que la existencia no cambie a medio ajuste.
      await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [producto.id]);
      const lotes = await manager.findBy(LoteEntidad, { productoId: producto.id });
      const plan = this.regla(() => planAjuste(producto.unidad, lotes, datos.contada));
      const contada = plan.registrada.plus(plan.diferencia);
      const detalle: DetalleAjuste = { ajuste: null, producto, contada, lotes: [], usuarioId, ...plan };
      if (plan.diferencia.isZero()) return detalle;

      const ahora = new Date();
      const ajuste = manager.create(AjusteEntidad, {
        id: randomUUID(),
        productoId: producto.id,
        registrada: plan.registrada,
        contada,
        diferencia: plan.diferencia,
        usuarioId,
        fecha: ahora,
      });
      await manager.insert(AjusteEntidad, ajuste);

      // Si no hay lotes, lo contado va a un lote nuevo; de ese no se sabe la caducidad.
      if (plan.loteNuevo) {
        const lote = manager.create(LoteEntidad, {
          id: randomUUID(),
          productoId: producto.id,
          caducidad: null,
          existencia: plan.loteNuevo,
          cantidadInicial: plan.loteNuevo,
          origen: 'AJUSTE',
          creadoEn: ahora,
        });
        await manager.insert(LoteEntidad, lote);
        await manager.insert(AjusteLoteEntidad, {
          ajusteId: ajuste.id,
          loteId: lote.id,
          cambio: plan.loteNuevo,
        });
        detalle.lotes.push({ loteId: lote.id, cambio: plan.loteNuevo, existencia: plan.loteNuevo });
      }

      for (const cambio of plan.cambios) {
        const lote = lotes.find((l) => l.id === cambio.loteId)!;
        const existencia = lote.existencia.plus(cambio.cantidad);
        await manager.update(LoteEntidad, lote.id, { existencia });
        await manager.insert(AjusteLoteEntidad, {
          ajusteId: ajuste.id,
          loteId: lote.id,
          cambio: cambio.cantidad,
        });
        detalle.lotes.push({ loteId: lote.id, cambio: cambio.cantidad, existencia });
      }

      await this.bitacora.registrar(
        {
          usuarioId,
          accion: 'AJUSTE_REGISTRADO',
          entidad: 'ajuste',
          entidadId: ajuste.id,
          antes: { existencia: plan.registrada.toFixed(2) },
          despues: {
            productoId: producto.id,
            existencia: contada.toFixed(2),
            diferencia: plan.diferencia.toFixed(2),
            lotes: detalle.lotes.map((l) => ({ loteId: l.loteId, cambio: l.cambio.toFixed(2) })),
          },
        },
        manager,
      );
      return { ...detalle, ajuste };
    });
  }

  /** Entradas de la más nueva a la más vieja, por páginas. */
  async listarEntradas(consulta: ConsultaEntradas): Promise<{ entradas: DetalleEntrada[]; total: number }> {
    const [entradas, total] = await this.entradas.findAndCount({
      order: { fecha: 'DESC' },
      skip: (consulta.page - 1) * consulta.limit,
      take: consulta.limit,
    });
    return { entradas: await Promise.all(entradas.map((e) => this.completar(e))), total };
  }

  /** Una entrada con sus renglones. */
  async entrada(id: string): Promise<DetalleEntrada> {
    const entrada = await this.entradas.findOneBy({ id });
    if (!entrada) throw new NoEncontrado('La entrada no existe');
    return this.completar(entrada);
  }

  /**
   * Regresa a su lote las unidades devueltas. Si van a merma, la existencia no cambia y se registra la
   * salida con el folio como motivo; regresa el id de esa salida. Corre dentro de la transacción de la
   * devolución.
   */
  async regresarDevolucion(
    manager: EntityManager,
    d: {
      productoId: string;
      loteId: string;
      cantidad: Decimal;
      merma: boolean;
      folio: number;
      comentario: string;
      usuarioId: string;
    },
  ): Promise<string | null> {
    await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [d.productoId]);
    if (!d.merma) {
      await manager.increment(LoteEntidad, { id: d.loteId }, 'existencia', d.cantidad.toFixed(2));
      return null;
    }
    const salida = manager.create(SalidaEntidad, {
      id: randomUUID(),
      tipo: 'MERMA',
      productoId: d.productoId,
      loteId: d.loteId,
      cantidad: d.cantidad,
      motivo: `Devolución del folio ${d.folio}`,
      comentario: d.comentario,
      usuarioId: d.usuarioId,
      fecha: new Date(),
    });
    await manager.insert(SalidaEntidad, salida);
    return salida.id;
  }

  /**
   * Descuenta lo vendido empezando por el lote que caduca primero (es regla); el reparto lo calcula
   * planDescuento del paquete compartido. Corre dentro de la transacción del cobro.
   * Si no alcanza, la venta sigue igual: el último lote queda en negativo, o se crea un lote 'FALTANTE'
   * si el producto no tenía lotes.
   */
  async descontarPorCaducidad(
    manager: EntityManager,
    productoId: string,
    cantidad: ValorDecimal,
  ): Promise<Descuento> {
    // Candado por producto: si llegan dos cobros del mismo producto al mismo tiempo, el segundo espera.
    // Se suelta al terminar la transacción.
    await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [productoId]);

    const lotes = await manager.findBy(LoteEntidad, { productoId });
    const { consumos, faltante } = planDescuento(lotes, cantidad);

    // Sin lotes: se crea uno con existencia negativa.
    if (consumos.length === 0) {
      const lote = manager.create(LoteEntidad, {
        id: randomUUID(),
        productoId,
        caducidad: null,
        existencia: faltante.negated(),
        cantidadInicial: new Decimal(0),
        origen: 'FALTANTE',
        creadoEn: new Date(),
      });
      await manager.insert(LoteEntidad, lote);
      return { consumos: [{ loteId: lote.id, cantidad: faltante }], faltante };
    }

    // La resta se hace en SQL ("existencia - X") para usar siempre el valor más reciente.
    for (const consumo of consumos) {
      await manager.query('UPDATE lote SET existencia = existencia - $1 WHERE id = $2', [
        consumo.cantidad.toFixed(2),
        consumo.loteId,
      ]);
    }
    return { consumos, faltante };
  }

  /**
   * Existencia de un producto con su mínima y sus lotes, del que caduca primero al último. Los lotes en
   * cero no se enseñan.
   */
  async existenciasDe(productoId: string): Promise<Existencias> {
    const producto = await this.productos.findOneBy({ id: productoId });
    if (!producto) throw new NoEncontrado('El producto no existe');
    const lotes = ordenarPorCaducidad(await this.lotes.findBy({ productoId }));
    const existencia = lotes.reduce((total, l) => total.plus(l.existencia), new Decimal(0));
    const hoy = fechaLocal(new Date());
    return {
      producto: {
        id: producto.id,
        codigo: producto.codigo,
        nombre: producto.nombre,
        unidad: producto.unidad,
      },
      existencia: existencia.toFixed(2),
      existenciaMinima: producto.existenciaMinima.toFixed(2),
      enMinimo: enExistenciaMinima(existencia, producto.existenciaMinima),
      lotes: lotes
        .filter((l) => !l.existencia.isZero())
        .map((l) => ({
          id: l.id,
          caducidad: l.caducidad,
          diasParaCaducar: l.caducidad ? diasParaCaducar(l.caducidad, hoy) : null,
          existencia: l.existencia.toFixed(2),
          origen: l.origen,
          creadoEn: l.creadoEn.toISOString(),
        })),
    };
  }

  /**
   * Alertas de inventario. Se calculan en el momento porque cambian con cada venta: productos activos en
   * su existencia mínima y lotes con existencia que caducan en 7 días o menos, contando los ya caducados.
   * Los lotes "No aplica" no alertan.
   */
  async alertas(): Promise<Alertas> {
    const hoy = fechaLocal(new Date());
    const productos = await this.productos.find({ where: { activo: true }, order: { nombre: 'ASC' } });
    const existencias = await this.existencias(productos.map((p) => p.id));
    const porId = new Map(productos.map((p) => [p.id, p]));

    const minimo = productos
      .filter((p) => enExistenciaMinima(existencias.get(p.id)!, p.existenciaMinima))
      .map((p) => ({
        productoId: p.id,
        nombre: p.nombre,
        unidad: p.unidad,
        existencia: existencias.get(p.id)!.toFixed(2),
        existenciaMinima: p.existenciaMinima.toFixed(2),
      }));

    const lotes =
      productos.length === 0 ? [] : await this.lotes.findBy({ productoId: In([...porId.keys()]) });
    const caducidad = ordenarPorCaducidad(lotes.filter((l) => caducaPronto(l, hoy))).map((l) => {
      const dias = diasParaCaducar(l.caducidad!, hoy);
      return {
        loteId: l.id,
        productoId: l.productoId,
        nombre: porId.get(l.productoId)!.nombre,
        caducidad: l.caducidad!,
        diasParaCaducar: dias,
        caducado: dias < 0,
        existencia: l.existencia.toFixed(2),
      };
    });
    return { fecha: hoy, minimo, caducidad, ultimaRevision: await this.ultimaRevision() };
  }

  /** Resumen de las mismas alertas, para cuando se abre la caja. */
  async resumenAlertas(): Promise<ResumenAlertas> {
    const { minimo, caducidad } = await this.alertas();
    const caducados = caducidad.filter((l) => l.caducado).length;
    const conteo = { minimo: minimo.length, porCaducar: caducidad.length - caducados, caducados };
    return { ...conteo, mensaje: fraseDeAlertas(conteo) };
  }

  /**
   * Revisión diaria de caducidades: cuenta los lotes de productos activos que caducan en 7 días o menos
   * y los ya caducados, y apunta el resumen al final junto con su bitácora. Si la de hoy ya se hizo, no
   * la repite y regresa null.
   */
  async revisarCaducidades(): Promise<ResumenRevision | null> {
    const ahora = new Date();
    const hoy = fechaLocal(ahora);
    try {
      return await conTransaccion(async (manager) => {
        if (await manager.existsBy(EjecucionTareaEntidad, { tarea: TAREA_REVISION, fecha: hoy })) return null;
        const lotes = await manager
          .createQueryBuilder(LoteEntidad, 'l')
          .innerJoin(ProductoEntidad, 'p', 'p.id = l.producto_id AND p.activo')
          .getMany();
        const resultado = resumenCaducidad(lotes, hoy);
        const ejecucion = manager.create(EjecucionTareaEntidad, {
          id: randomUUID(),
          tarea: TAREA_REVISION,
          fecha: hoy,
          ejecutadaEn: ahora,
          resultado,
        });
        await manager.insert(EjecucionTareaEntidad, ejecucion);
        await this.bitacora.registrar(
          {
            usuarioId: null,
            accion: 'REVISION_CADUCIDADES',
            entidad: 'ejecucion_tarea',
            entidadId: ejecucion.id,
            despues: { fecha: hoy, ...resultado },
          },
          manager,
        );
        return aRevision(ejecucion);
      });
    } catch (error) {
      // La hora programada y el arranque cayeron al mismo tiempo: el índice único deja pasar solo una.
      if (esDuplicado(error, 'ejecucion_tarea_dia')) return null;
      throw error;
    }
  }

  /** Dice si falta la revisión de hoy: ya pasó HORA_REVISION y todavía no se hace. */
  async revisionPendiente(): Promise<boolean> {
    const ahora = new Date();
    const ultima = await this.ultimaRevision();
    return revisionPendiente(
      ultima?.fecha ?? null,
      fechaLocal(ahora),
      horaLocal(ahora),
      configuracion.horaRevision,
    );
  }

  private async ultimaRevision(): Promise<ResumenRevision | null> {
    const ultima = await fuenteDatos
      .getRepository(EjecucionTareaEntidad)
      .findOne({ where: { tarea: TAREA_REVISION }, order: { fecha: 'DESC' } });
    return ultima ? aRevision(ultima) : null;
  }

  /** Existencia de un producto. */
  async existencia(productoId: string): Promise<Decimal> {
    return (await this.existencias([productoId])).get(productoId)!;
  }

  /** Existencias de varios productos en una sola consulta (productoId → existencia; 0 si no hay lotes). */
  async existencias(productoIds: string[]): Promise<Map<string, Decimal>> {
    const resultado = new Map(productoIds.map((id) => [id, new Decimal(0)]));
    if (productoIds.length === 0) return resultado;

    const filas: { producto_id: string; total: string }[] = await this.lotes
      .createQueryBuilder('l')
      .select('l.producto_id', 'producto_id')
      .addSelect('SUM(l.existencia)', 'total')
      .where('l.producto_id IN (:...productoIds)', { productoIds })
      .groupBy('l.producto_id')
      .getRawMany();

    for (const f of filas) resultado.set(f.producto_id, new Decimal(f.total));
    return resultado;
  }

  // Ayudantes de adentro

  /** Guarda el pago como movimiento de la caja y lo apunta en la bitácora. */
  private async guardarPago(
    manager: EntityManager,
    caja: CajaEntidad,
    entrada: EntradaEntidad,
    proveedor: string,
    datos: PagoProveedor,
    usuarioId: string,
  ): Promise<MovimientoEfectivoEntidad> {
    const pago = await this.caja.registrarPagoProveedor(manager, {
      cajaId: caja.id,
      entradaId: entrada.id,
      monto: new Decimal(datos.monto),
      // Si no se manda motivo, se propone con el folio de la nota.
      motivo: datos.motivo ?? `Pago de la nota ${entrada.folioNota} de ${proveedor}`,
      usuarioId,
    });
    await this.bitacora.registrar(
      {
        usuarioId,
        accion: 'PAGO_PROVEEDOR',
        entidad: 'movimiento_efectivo',
        entidadId: pago.id,
        despues: {
          entradaId: entrada.id,
          cajaId: caja.id,
          monto: pago.monto.toFixed(2),
          motivo: pago.motivo,
        },
      },
      manager,
    );
    return pago;
  }

  /** Productos activos por id; si alguno no existe o está desactivado, 422. */
  private async productosActivos(ids: string[]): Promise<Map<string, ProductoEntidad>> {
    const productos = await this.productos.findBy({ id: In([...new Set(ids)]) });
    const mapa = new Map(productos.map((p) => [p.id, p]));
    for (const id of ids) {
      const p = mapa.get(id);
      if (!p) throw new ReglaDeNegocio('Uno de los productos de la entrada no existe');
      if (!p.activo) throw new ReglaDeNegocio(`El producto ${p.nombre} está desactivado`);
    }
    return mapa;
  }

  /** Agrega a una entrada sus renglones, el proveedor y los productos. */
  private async completar(entrada: EntradaEntidad): Promise<DetalleEntrada> {
    const renglones = await this.detalles.find({
      where: { entradaId: entrada.id },
      order: { renglon: 'ASC' },
    });
    const productos = await this.productos.findBy({ id: In(renglones.map((r) => r.productoId)) });
    const proveedor = await this.proveedores.porId(entrada.proveedorId);
    return {
      entrada,
      proveedor: { id: entrada.proveedorId, nombre: proveedor!.nombre },
      renglones,
      productos: new Map(productos.map((p) => [p.id, p])),
      pago: await this.movimientos.findOneBy({ entradaId: entrada.id }),
    };
  }

  /** Las cuentas del paquete compartido lanzan RangeError; aquí se convierten en 422. */
  private regla<T>(calculo: () => T): T {
    try {
      return calculo();
    } catch (error) {
      if (error instanceof RangeError) throw new ReglaDeNegocio(error.message);
      throw error;
    }
  }
}

/** Dice si el error es de valor repetido (23505) en la restricción indicada. */
function esDuplicado(error: unknown, restriccion: string): boolean {
  if (!(error instanceof QueryFailedError)) return false;
  const { code, constraint } = error.driverError as { code?: string; constraint?: string };
  return code === '23505' && constraint === restriccion;
}

/** Entrada en el formato de la respuesta: montos con 2 decimales y fecha ISO. */
function aEntrada(d: DetalleEntrada): Entrada {
  return {
    id: d.entrada.id,
    proveedor: d.proveedor,
    folioNota: d.entrada.folioNota,
    fecha: d.entrada.fecha.toISOString(),
    usuarioId: d.entrada.usuarioId,
    total: d.entrada.total.toFixed(2),
    pago: d.pago
      ? {
          movimientoId: d.pago.id,
          monto: d.pago.monto.toFixed(2),
          motivo: d.pago.motivo,
          usuarioId: d.pago.usuarioId,
          fecha: d.pago.fecha.toISOString(),
        }
      : null,
    renglones: d.renglones.map((r) => {
      const producto = d.productos.get(r.productoId)!;
      return {
        productoId: r.productoId,
        nombre: producto.nombre,
        unidad: producto.unidad,
        cantidad: producto.unidad === 'PIEZA' ? r.cantidad.toFixed(0) : r.cantidad.toFixed(2),
        costoUnitario: r.costoUnitario.toFixed(2),
        importe: r.importe.toFixed(2),
        caducidad: r.caducidad,
        loteId: r.loteId,
      };
    }),
  };
}

/** Salida en el formato de la respuesta. */
function aSalida(d: DetalleSalida): SalidaInventario {
  const { salida, lote, producto } = d;
  return {
    id: salida.id,
    tipo: salida.tipo,
    producto: { id: producto.id, nombre: producto.nombre, unidad: producto.unidad },
    loteId: lote.id,
    caducidad: lote.caducidad,
    cantidad: producto.unidad === 'PIEZA' ? salida.cantidad.toFixed(0) : salida.cantidad.toFixed(2),
    existenciaLote: lote.existencia.toFixed(2),
    motivo: salida.motivo,
    comentario: salida.comentario,
    usuarioId: salida.usuarioId,
    fecha: salida.fecha.toISOString(),
  };
}

/** Ajuste en el formato de la respuesta. */
function aAjuste(d: DetalleAjuste): AjusteInventario {
  return {
    id: d.ajuste?.id ?? null,
    producto: { id: d.producto.id, nombre: d.producto.nombre, unidad: d.producto.unidad },
    registrada: d.registrada.toFixed(2),
    contada: d.contada.toFixed(2),
    diferencia: d.diferencia.toFixed(2),
    lotes: d.lotes.map((l) => ({
      loteId: l.loteId,
      cambio: l.cambio.toFixed(2),
      existencia: l.existencia.toFixed(2),
    })),
    usuarioId: d.usuarioId,
    fecha: d.ajuste?.fecha.toISOString() ?? null,
  };
}

// --- Rutas ---
// Dueño y Empleado registran, pagan y consultan entradas, registran mermas y consumo, y ajustan por conteo.

export function rutasInventario(): Router {
  const router = Router();
  const servicio = new InventarioServicio();

  // POST /inventario/entradas
  router.post(
    '/inventario/entradas',
    autenticar,
    autorizar('inventario:entrada'),
    validar({ body: esquemaEntradaNueva }),
    async (req, res) => {
      const { detalle, avisoPago } = await servicio.registrarEntrada(
        datos<EntradaNueva>(req, 'body'),
        sesionDe(req).usuarioId,
      );
      let mensaje = detalle.pago ? 'Entrada registrada y pagada' : 'Entrada registrada';
      if (avisoPago) mensaje = `Entrada registrada sin pago: ${avisoPago}. El pago puede registrarse después`;
      emitir('alertas:actualizadas');
      responder(res, aEntrada(detalle), mensaje, 201);
    },
  );

  // POST /inventario/entradas/:id/pago  { monto, motivo? }
  router.post(
    '/inventario/entradas/:id/pago',
    autenticar,
    autorizar('inventario:entrada'),
    validar({ params: esquemaId, body: esquemaPagoProveedor }),
    async (req, res) => {
      const { id } = datos<{ id: string }>(req, 'params');
      const detalle = await servicio.pagarEntrada(
        id,
        datos<PagoProveedor>(req, 'body'),
        sesionDe(req).usuarioId,
      );
      responder(res, aEntrada(detalle), 'Pago al proveedor registrado', 201);
    },
  );

  // POST /inventario/salidas  { tipo, productoId, loteId?, cantidad, motivo, comentario? }
  router.post(
    '/inventario/salidas',
    autenticar,
    autorizar('inventario:salida'),
    validar({ body: esquemaSalidaNueva }),
    async (req, res) => {
      const detalle = await servicio.registrarSalida(
        datos<SalidaNueva>(req, 'body'),
        sesionDe(req).usuarioId,
      );
      const mensaje = detalle.salida.tipo === 'MERMA' ? 'Merma registrada' : 'Consumo propio registrado';
      emitir('alertas:actualizadas');
      responder(res, aSalida(detalle), mensaje, 201);
    },
  );

  // POST /inventario/ajustes  { productoId, contada }
  router.post(
    '/inventario/ajustes',
    autenticar,
    autorizar('inventario:ajuste'),
    validar({ body: esquemaAjusteNuevo }),
    async (req, res) => {
      const detalle = await servicio.registrarAjuste(
        datos<AjusteNuevo>(req, 'body'),
        sesionDe(req).usuarioId,
      );
      if (!detalle.ajuste) {
        responder(res, aAjuste(detalle), 'El conteo coincide con la existencia; no se registró ajuste');
      } else {
        emitir('alertas:actualizadas');
        responder(res, aAjuste(detalle), 'Ajuste registrado', 201);
      }
    },
  );

  // GET /inventario/existencias/:id
  router.get(
    '/inventario/existencias/:id',
    autenticar,
    autorizar('inventario:consultar'),
    validar({ params: esquemaId }),
    async (req, res) => {
      const { id } = datos<{ id: string }>(req, 'params');
      responder(res, await servicio.existenciasDe(id), 'Existencia y lotes del producto');
    },
  );

  // GET /inventario/alertas
  router.get('/inventario/alertas', autenticar, autorizar('inventario:consultar'), async (_req, res) => {
    const alertas = await servicio.alertas();
    const total = alertas.minimo.length + alertas.caducidad.length;
    responder(res, alertas, total === 0 ? 'No hay alertas de inventario' : `${total} alertas de inventario`);
  });

  // GET /inventario/entradas?page=1&limit=20
  router.get(
    '/inventario/entradas',
    autenticar,
    autorizar('inventario:consultar'),
    validar({ query: esquemaConsultaEntradas }),
    async (req, res) => {
      const consulta = datos<ConsultaEntradas>(req, 'query');
      const { entradas, total } = await servicio.listarEntradas(consulta);
      const meta = paginacion(consulta.page, consulta.limit, total);
      responder(res, entradas.map(aEntrada), 'Entradas de mercancía', 200, meta);
    },
  );

  // GET /inventario/entradas/:id
  router.get(
    '/inventario/entradas/:id',
    autenticar,
    autorizar('inventario:consultar'),
    validar({ params: esquemaId }),
    async (req, res) => {
      const { id } = datos<{ id: string }>(req, 'params');
      responder(res, aEntrada(await servicio.entrada(id)), 'Entrada de mercancía');
    },
  );

  return router;
}

// --- Swagger ---

export function documentarInventario(registro: OpenAPIRegistry): void {
  const etiqueta = 'Inventario';
  documentar(registro, [
    {
      metodo: 'post',
      ruta: '/inventario/entradas',
      resumen:
        'Registrar una entrada de mercancía; cada producto crea un lote. El pago es opcional y por el total de la nota: sin caja abierta o sin efectivo suficiente, la entrada queda sin pago',
      etiqueta,
      permiso: 'inventario:entrada',
      body: esquemaEntradaNueva,
      respuesta: esquemaEntrada,
      estado: 201,
      errores: [409, 422],
    },
    {
      metodo: 'post',
      ruta: '/inventario/entradas/:id/pago',
      resumen:
        'Pagar después una entrada que quedó sin pago, por su total; sale de la caja abierta de hoy si el efectivo alcanza',
      etiqueta,
      permiso: 'inventario:entrada',
      params: esquemaId,
      body: esquemaPagoProveedor,
      respuesta: esquemaEntrada,
      estado: 201,
      errores: [404, 409, 422],
    },
    {
      metodo: 'post',
      ruta: '/inventario/salidas',
      resumen:
        'Registrar una merma o consumo propio con motivo; sin lote elegido, sale del que caduca primero',
      etiqueta,
      permiso: 'inventario:salida',
      body: esquemaSalidaNueva,
      respuesta: esquemaSalidaInventario,
      estado: 201,
      errores: [422],
    },
    {
      metodo: 'post',
      ruta: '/inventario/ajustes',
      resumen:
        'Ajustar la existencia a lo contado; si coincide no se registra (200), si no, se registra el ajuste (201)',
      etiqueta,
      permiso: 'inventario:ajuste',
      body: esquemaAjusteNuevo,
      respuesta: esquemaAjusteInventario,
      estado: 201,
      errores: [422],
    },
    {
      metodo: 'get',
      ruta: '/inventario/existencias/:id',
      resumen: 'Consultar la existencia de un producto con su mínima y sus lotes',
      etiqueta,
      permiso: 'inventario:consultar',
      params: esquemaId,
      respuesta: esquemaExistencias,
      errores: [404],
    },
    {
      metodo: 'get',
      ruta: '/inventario/alertas',
      resumen: 'Consultar las alertas de existencia mínima y de caducidad en 7 días o menos',
      etiqueta,
      permiso: 'inventario:consultar',
      respuesta: esquemaAlertas,
    },
    {
      metodo: 'get',
      ruta: '/inventario/entradas',
      resumen: 'Listar entradas de mercancía, de la más reciente a la más antigua',
      etiqueta,
      permiso: 'inventario:consultar',
      query: esquemaConsultaEntradas,
      respuesta: z.array(esquemaEntrada),
      paginada: true,
    },
    {
      metodo: 'get',
      ruta: '/inventario/entradas/:id',
      resumen: 'Consultar una entrada de mercancía',
      etiqueta,
      permiso: 'inventario:consultar',
      params: esquemaId,
      respuesta: esquemaEntrada,
      errores: [404],
    },
  ]);
}
