/**
 * Módulo devoluciones: productos que regresan de una venta del día, buscada por su folio. Cada producto
 * regresa a su lote o se va a merma, y el reembolso sale en efectivo de la caja o como saldo a favor
 * para otra compra del mismo día. Si con la devolución ya no queda nada por devolver, en realidad es
 * cancelar la venta: regla, eso solo lo hace el Dueño y se reembolsa en efectivo.
 * Las entidades están en devoluciones.tablas.ts.
 */
import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { In } from 'typeorm';
import {
  Decimal,
  esquemaDevolucion,
  esquemaDevolucionNueva,
  esquemaFolio,
  esquemaVentaDevolvible,
  netoPorRenglon,
  ordenarPorCaducidad,
  planDevolucion,
  reembolsoEfectivo,
  tienePermiso,
  type Devolucion,
  type DevolucionNueva,
  type Rol,
  type VentaDevolvible,
} from '@pos/compartido';
import { documentar } from '../../comun/documentar';
import { NoEncontrado, Prohibido, ReglaDeNegocio } from '../../comun/errores';
import { fechaLocal } from '../../comun/fechas';
import { responder } from '../../comun/respuesta';
import { autenticar, autorizar } from '../../comun/seguridad';
import { sesionDe } from '../../comun/sesion';
import { emitir } from '../../comun/tiempo-real';
import { datos, validar } from '../../comun/validar';
import { fuenteDatos } from '../../infraestructura/base-datos/fuente';
import { conTransaccion } from '../../infraestructura/base-datos/transaccion';
import { BitacoraServicio } from '../bitacora/bitacora';
import { CajaServicio } from '../caja/caja';
import { InventarioServicio } from '../inventario/inventario';
import { LoteEntidad } from '../inventario/inventario.tablas';
import { VentasServicio } from '../ventas/ventas';
import {
  SaldoFavorEntidad,
  VentaDetalleEntidad,
  VentaDetalleLoteEntidad,
  VentaEntidad,
} from '../ventas/ventas.tablas';
import { DevolucionDetalleEntidad, DevolucionEntidad, DevolucionLoteEntidad } from './devoluciones.tablas';

/** Renglón de la venta con lo ya devuelto y lo que se pagó por él. */
interface RenglonVenta {
  detalle: VentaDetalleEntidad;
  devuelta: Decimal;
  neto: Decimal;
}

/** Venta del día lista para devolver. */
interface VentaParaDevolver {
  venta: VentaEntidad;
  renglones: RenglonVenta[];
  reembolsado: Decimal;
}

/** Devolución registrada con sus renglones. */
interface DetalleDevolucion {
  devolucion: DevolucionEntidad;
  folio: number;
  saldo: SaldoFavorEntidad | null;
  renglones: { detalle: DevolucionDetalleEntidad; venta: VentaDetalleEntidad }[];
}

// --- Reglas ---

export class DevolucionesServicio {
  private caja = new CajaServicio();
  private inventario = new InventarioServicio();
  private ventas = new VentasServicio();
  private bitacora = new BitacoraServicio();

  /** Lo que todavía se puede devolver de una venta del día. */
  async devolvible(folio: number): Promise<VentaParaDevolver> {
    return this.ventaDelDia(fuenteDatos.manager, folio);
  }

  /**
   * Registra la devolución de un jalón: renglones, regreso a los lotes o merma, reembolso de la caja y
   * bitácora.
   */
  async registrar(datos: DevolucionNueva, usuarioId: string, rol: Rol): Promise<DetalleDevolucion> {
    const caja = await this.caja.cajaAbiertaDeHoy();

    return conTransaccion(async (manager) => {
      const { venta, renglones, reembolsado } = await this.ventaDelDia(manager, datos.folio);
      // Candado por venta: si llegan dos devoluciones del mismo folio a la vez, no se devuelve de más.
      await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [venta.id]);

      const plan = this.regla(() =>
        planDevolucion(
          renglones.map((r) => ({
            renglon: r.detalle.renglon,
            unidad: r.detalle.unidad,
            vendida: r.detalle.cantidad,
            devuelta: r.devuelta,
            neto: r.neto,
          })),
          datos.renglones,
        ),
      );
      if (plan.completa && !tienePermiso(rol, 'devolucion:total')) {
        throw new Prohibido('Solo el Dueño devuelve la venta completa; devuelva solo una parte');
      }
      const pendiente = venta.totalCobrado.minus(reembolsado);
      const conSaldo = datos.reembolso === 'SALDO_FAVOR';
      if (conSaldo && plan.completa) {
        throw new ReglaDeNegocio('La devolución completa se reembolsa en efectivo; devuelva solo una parte');
      }
      // Con saldo a favor no sale efectivo; el saldo es lo pagado, sin redondear.
      const reembolso = conSaldo ? new Decimal(0) : reembolsoEfectivo(plan.monto, pendiente, plan.completa);
      const montoSaldo = Decimal.min(plan.monto, pendiente);
      if (conSaldo && montoSaldo.lte(0)) throw new ReglaDeNegocio('No queda nada que dar como saldo a favor');

      const devolucion = manager.create(DevolucionEntidad, {
        id: randomUUID(),
        ventaId: venta.id,
        cajaId: caja.id,
        tipo: plan.completa ? 'TOTAL' : 'PARCIAL',
        motivo: datos.motivo,
        formaReembolso: datos.reembolso,
        reembolso,
        usuarioId,
        fecha: new Date(),
      });
      await manager.insert(DevolucionEntidad, devolucion);

      const registrados: DetalleDevolucion['renglones'] = [];
      for (const [i, s] of datos.renglones.entries()) {
        const vendido = renglones.find((r) => r.detalle.renglon === s.renglon)!.detalle;
        const detalle = manager.create(DevolucionDetalleEntidad, {
          id: randomUUID(),
          devolucionId: devolucion.id,
          ventaDetalleId: vendido.id,
          cantidad: new Decimal(s.cantidad),
          importe: plan.montos[i]!,
          destino: s.destino,
        });
        await manager.insert(DevolucionDetalleEntidad, detalle);

        for (const { loteId, cantidad } of await this.lotesARegresar(manager, vendido, detalle.cantidad)) {
          const salidaId = await this.inventario.regresarDevolucion(manager, {
            productoId: vendido.productoId,
            loteId,
            cantidad,
            merma: s.destino === 'MERMA',
            folio: venta.folio!,
            comentario: datos.motivo,
            usuarioId,
          });
          await manager.insert(DevolucionLoteEntidad, {
            devolucionDetalleId: detalle.id,
            loteId,
            cantidad,
            salidaId,
          });
        }
        registrados.push({ detalle, venta: vendido });
      }

      const saldo = conSaldo
        ? await this.ventas.crearSaldoFavor(manager, { devolucionId: devolucion.id, monto: montoSaldo })
        : null;

      // Si no hay efectivo de por medio (saldo a favor o venta con 100 % de descuento), no hay movimiento.
      if (reembolso.gt(0)) {
        await this.caja.registrarReembolso(manager, {
          cajaId: caja.id,
          devolucionId: devolucion.id,
          monto: reembolso,
          motivo: `Devolución del folio ${venta.folio}`,
          usuarioId,
        });
      }

      await this.bitacora.registrar(
        {
          usuarioId,
          accion: 'DEVOLUCION_REGISTRADA',
          entidad: 'devolucion',
          entidadId: devolucion.id,
          despues: {
            folio: venta.folio,
            tipo: devolucion.tipo,
            motivo: devolucion.motivo,
            formaReembolso: devolucion.formaReembolso,
            reembolso: reembolso.toFixed(2),
            saldoFavor: saldo?.monto.toFixed(2) ?? null,
            renglones: registrados.map((r) => ({
              renglon: r.venta.renglon,
              cantidad: r.detalle.cantidad.toFixed(2),
              destino: r.detalle.destino,
            })),
          },
        },
        manager,
      );
      return { devolucion, folio: venta.folio!, saldo, renglones: registrados };
    });
  }

  // Ayudantes de adentro

  /** Venta cobrada de hoy con lo ya devuelto de cada renglón. Regla: solo ventas del mismo día. */
  private async ventaDelDia(manager: typeof fuenteDatos.manager, folio: number): Promise<VentaParaDevolver> {
    const venta = await manager.findOneBy(VentaEntidad, { folio, estado: 'COBRADA' });
    if (!venta) throw new NoEncontrado(`No existe una venta cobrada con el folio ${folio}`);
    if (fechaLocal(venta.fecha) !== fechaLocal(new Date())) {
      throw new ReglaDeNegocio(
        `Solo se aceptan devoluciones de ventas del día; el folio ${folio} es de otro día`,
      );
    }

    const detalles = await manager.find(VentaDetalleEntidad, {
      where: { ventaId: venta.id },
      order: { renglon: 'ASC' },
    });
    const devueltos = await manager.findBy(DevolucionDetalleEntidad, {
      ventaDetalleId: In(detalles.map((d) => d.id)),
    });
    const devoluciones = await manager.findBy(DevolucionEntidad, { ventaId: venta.id });
    const saldos = await manager.findBy(SaldoFavorEntidad, {
      devolucionId: In(devoluciones.map((d) => d.id)),
    });

    // El descuento de la venta incluye los de los renglones; lo que sobra es el descuento general.
    const descuentosRenglones = detalles.reduce((s, d) => s.plus(d.descuentoManual), new Decimal(0));
    const netos = netoPorRenglon(
      detalles.map((d) => ({
        importe: d.importe,
        descuento: d.descuentoManual.plus(d.descuentoPromocion),
      })),
      venta.descuentoManual.minus(descuentosRenglones),
    );
    return {
      venta,
      renglones: detalles.map((detalle, i) => ({
        detalle,
        devuelta: devueltos
          .filter((d) => d.ventaDetalleId === detalle.id)
          .reduce((s, d) => s.plus(d.cantidad), new Decimal(0)),
        neto: netos[i]!,
      })),
      // Lo que ya se le regresó al cliente: en efectivo y como saldo a favor.
      reembolsado: [...devoluciones.map((d) => d.reembolso), ...saldos.map((s) => s.monto)].reduce(
        (s, m) => s.plus(m),
        new Decimal(0),
      ),
    };
  }

  /**
   * Lotes a los que regresa lo devuelto: los mismos de donde salió en la venta, empezando por el que
   * caduca más tarde, sin pasarse de lo que salió de cada uno menos lo que ya regresó.
   */
  private async lotesARegresar(
    manager: typeof fuenteDatos.manager,
    vendido: VentaDetalleEntidad,
    cantidad: Decimal,
  ): Promise<{ loteId: string; cantidad: Decimal }[]> {
    const salidas = await manager.findBy(VentaDetalleLoteEntidad, { ventaDetalleId: vendido.id });
    const lotes = await manager.findBy(LoteEntidad, { id: In(salidas.map((s) => s.loteId)) });
    const regresados = await manager
      .createQueryBuilder(DevolucionLoteEntidad, 'dl')
      .innerJoin(DevolucionDetalleEntidad, 'dd', 'dd.id = dl.devolucion_detalle_id')
      .where('dd.venta_detalle_id = :id', { id: vendido.id })
      .getMany();

    const resultado: { loteId: string; cantidad: Decimal }[] = [];
    let restante = cantidad;
    for (const lote of ordenarPorCaducidad(lotes).reverse()) {
      if (restante.isZero()) break;
      const salio = salidas.find((s) => s.loteId === lote.id)!.cantidad;
      const yaRegreso = regresados
        .filter((r) => r.loteId === lote.id)
        .reduce((s, r) => s.plus(r.cantidad), new Decimal(0));
      const tomar = Decimal.min(salio.minus(yaRegreso), restante);
      if (tomar.gt(0)) {
        resultado.push({ loteId: lote.id, cantidad: tomar });
        restante = restante.minus(tomar);
      }
    }
    return resultado;
  }

  /** Las cuentas del paquete compartido lanzan RangeError; aquí se convierte en un 422. */
  private regla<T>(calculo: () => T): T {
    try {
      return calculo();
    } catch (error) {
      if (error instanceof RangeError) throw new ReglaDeNegocio(error.message);
      throw error;
    }
  }
}

// --- Formato de respuesta ---

function aDevolvible(v: VentaParaDevolver): VentaDevolvible {
  return {
    venta: {
      id: v.venta.id,
      folio: v.venta.folio!,
      fecha: v.venta.fecha.toISOString(),
      totalCobrado: v.venta.totalCobrado.toFixed(2),
      reembolsado: v.reembolsado.toFixed(2),
    },
    renglones: v.renglones.map((r) => ({
      renglon: r.detalle.renglon,
      productoId: r.detalle.productoId,
      nombre: r.detalle.nombre,
      unidad: r.detalle.unidad,
      vendida: r.detalle.cantidad.toFixed(2),
      devuelta: r.devuelta.toFixed(2),
      devolvible: r.detalle.cantidad.minus(r.devuelta).toFixed(2),
      neto: r.neto.toFixed(2),
    })),
  };
}

function aDevolucion(d: DetalleDevolucion): Devolucion {
  return {
    id: d.devolucion.id,
    folio: d.folio,
    tipo: d.devolucion.tipo,
    motivo: d.devolucion.motivo,
    formaReembolso: d.devolucion.formaReembolso,
    reembolso: d.devolucion.reembolso.toFixed(2),
    saldoFavor: d.saldo ? { id: d.saldo.id, monto: d.saldo.monto.toFixed(2) } : null,
    renglones: d.renglones.map((r) => ({
      renglon: r.venta.renglon,
      productoId: r.venta.productoId,
      nombre: r.venta.nombre,
      cantidad: r.detalle.cantidad.toFixed(2),
      destino: r.detalle.destino,
      importe: r.detalle.importe.toFixed(2),
    })),
    usuarioId: d.devolucion.usuarioId,
    fecha: d.devolucion.fecha.toISOString(),
  };
}

// --- Rutas ---
// Dueño y Empleado pueden devolver una parte. Regla: la venta completa, solo el Dueño.

export function rutasDevoluciones(): Router {
  const router = Router();
  const servicio = new DevolucionesServicio();

  // GET /devoluciones/folio/:folio
  router.get(
    '/devoluciones/folio/:folio',
    autenticar,
    autorizar('devolucion:parcial'),
    validar({ params: esquemaFolio }),
    async (req, res) => {
      const { folio } = datos<{ folio: number }>(req, 'params');
      responder(res, aDevolvible(await servicio.devolvible(folio)), 'Productos que se pueden devolver');
    },
  );

  // POST /devoluciones  { folio, motivo, renglones: [{ renglon, cantidad, destino }], reembolso? }
  router.post(
    '/devoluciones',
    autenticar,
    autorizar('devolucion:parcial'),
    validar({ body: esquemaDevolucionNueva }),
    async (req, res) => {
      const { usuarioId, rol } = sesionDe(req);
      const detalle = await servicio.registrar(datos<DevolucionNueva>(req, 'body'), usuarioId, rol);
      // Lo devuelto regresó al inventario, así que las alertas pueden cambiar.
      emitir('alertas:actualizadas');
      const mensaje =
        detalle.devolucion.tipo === 'TOTAL'
          ? `Venta con folio ${detalle.folio} devuelta completa`
          : detalle.saldo
            ? `Devolución registrada con saldo a favor de ${detalle.saldo.monto.toFixed(2)}`
            : 'Devolución registrada';
      responder(res, aDevolucion(detalle), mensaje, 201);
    },
  );

  return router;
}

// --- Swagger ---

export function documentarDevoluciones(registro: OpenAPIRegistry): void {
  const etiqueta = 'Devoluciones';
  documentar(registro, [
    {
      metodo: 'get',
      ruta: '/devoluciones/folio/:folio',
      resumen: 'Ver lo que aún se puede devolver de una venta del día',
      etiqueta,
      permiso: 'devolucion:parcial',
      params: esquemaFolio,
      respuesta: esquemaVentaDevolvible,
      errores: [404, 422],
    },
    {
      metodo: 'post',
      ruta: '/devoluciones',
      resumen:
        'Registrar una devolución con reembolso en efectivo o saldo a favor para una venta nueva del día; si ya no queda nada por devolver, es la cancelación de la venta, solo la hace el Dueño y es en efectivo',
      etiqueta,
      permiso: 'devolucion:parcial',
      body: esquemaDevolucionNueva,
      respuesta: esquemaDevolucion,
      estado: 201,
      errores: [404, 422],
    },
  ]);
}
