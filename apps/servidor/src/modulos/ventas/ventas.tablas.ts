/** Entidades de ventas: la venta, sus renglones, los lotes de cada renglón y los pagos. */
import { Column, Entity, PrimaryColumn } from 'typeorm';
import type { Decimal, MetodoPagoGuardado, Unidad } from '@pos/compartido';
import { columnaDecimal } from '../../infraestructura/base-datos/decimal';

// Definiciones de columna que se repiten.
const dinero = { type: 'numeric', precision: 12, scale: 2, transformer: columnaDecimal } as const;
const cantidad = { type: 'numeric', precision: 10, scale: 2, transformer: columnaDecimal } as const;

/** Tabla `venta`: las cobradas (con folio) y las canceladas sin cobrar (sin folio, quedan de constancia). */
@Entity('venta')
export class VentaEntidad {
  @PrimaryColumn('uuid')
  id!: string;

  // Consecutivo del ticket; null en las canceladas.
  @Column({ type: 'integer', nullable: true })
  folio!: number | null;

  @Column({ type: 'varchar', length: 9 })
  estado!: 'COBRADA' | 'CANCELADA';

  @Column({ name: 'caja_id', type: 'uuid' })
  cajaId!: string;

  // Quien empezó la venta; puede ser otra persona que quien cobró.
  @Column({ name: 'iniciada_por', type: 'uuid' })
  iniciadaPor!: string;

  @Column({ name: 'cobrada_por', type: 'uuid', nullable: true })
  cobradaPor!: string | null;

  // null si la canceló el sistema al cerrar la caja.
  @Column({ name: 'cancelada_por', type: 'uuid', nullable: true })
  canceladaPor!: string | null;

  // 'EN_CURSO' (cancelada en pantalla) o 'CIERRE' (al cerrar la caja).
  @Column({ name: 'motivo_cancelacion', type: 'varchar', length: 8, nullable: true })
  motivoCancelacion!: 'EN_CURSO' | 'CIERRE' | null;

  // Idempotency-Key del cobro: evita cobrar dos veces la misma venta.
  @Column({ name: 'clave_idempotencia', type: 'uuid', nullable: true })
  claveIdempotencia!: string | null;

  @Column(dinero)
  subtotal!: Decimal;

  @Column({ name: 'descuento_manual', ...dinero })
  descuentoManual!: Decimal;

  @Column({ name: 'ahorro_promociones', ...dinero })
  ahorroPromociones!: Decimal;

  @Column(dinero)
  total!: Decimal; // subtotal - ahorro de promociones - descuento

  @Column(dinero)
  redondeo!: Decimal; // redondeo del efectivo a 50 centavos

  @Column({ name: 'total_cobrado', ...dinero })
  totalCobrado!: Decimal;

  @Column(dinero)
  cambio!: Decimal;

  // Regla: después del original, los tickets salen como copia.
  @Column({ name: 'ticket_emitido', type: 'boolean' })
  ticketEmitido!: boolean;

  @Column({ type: 'timestamptz' })
  fecha!: Date;
}

/**
 * Tabla `venta_detalle`: un renglón por producto. Se copian el nombre y el precio de ese momento, para
 * que un cambio de precio después no le mueva nada a las ventas viejas.
 */
@Entity('venta_detalle')
export class VentaDetalleEntidad {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'venta_id', type: 'uuid' })
  ventaId!: string;

  @Column({ type: 'smallint' })
  renglon!: number;

  @Column({ name: 'producto_id', type: 'uuid' })
  productoId!: string;

  @Column({ type: 'varchar', length: 120 })
  nombre!: string;

  @Column({ type: 'varchar', length: 5 })
  unidad!: Unidad;

  @Column(dinero)
  precio!: Decimal;

  @Column(cantidad)
  cantidad!: Decimal;

  @Column(dinero)
  importe!: Decimal; // precio × cantidad, antes de descuentos

  @Column({ name: 'descuento_promocion', ...dinero })
  descuentoPromocion!: Decimal;

  // La promoción que se aplicó, si hubo.
  @Column({ name: 'promocion_id', type: 'uuid', nullable: true })
  promocionId!: string | null;

  @Column({ name: 'descuento_manual', ...dinero })
  descuentoManual!: Decimal;
}

/** Tabla `venta_detalle_lote`: de qué lotes salió cada renglón. */
@Entity('venta_detalle_lote')
export class VentaDetalleLoteEntidad {
  @PrimaryColumn({ name: 'venta_detalle_id', type: 'uuid' })
  ventaDetalleId!: string;

  @PrimaryColumn({ name: 'lote_id', type: 'uuid' })
  loteId!: string;

  @Column(cantidad)
  cantidad!: Decimal;
}

/** Tabla `pago`: una venta puede tener varios pagos (pago mixto). */
@Entity('pago')
export class PagoEntidad {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'venta_id', type: 'uuid' })
  ventaId!: string;

  @Column({ type: 'varchar', length: 13 })
  metodo!: MetodoPagoGuardado;

  @Column(dinero)
  monto!: Decimal;

  // Obligatoria con tarjeta y transferencia; en el saldo a favor, el id del saldo.
  @Column({ type: 'varchar', length: 40, nullable: true })
  referencia!: string | null;
}

/**
 * Tabla `saldo_favor`: lo que se devolvió como cambio por producto. Se usa una sola vez, como primer
 * pago de una venta nueva del mismo día; venta_id es la venta donde se usó.
 */
@Entity('saldo_favor')
export class SaldoFavorEntidad {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'devolucion_id', type: 'uuid' })
  devolucionId!: string;

  @Column(dinero)
  monto!: Decimal;

  @Column({ type: 'timestamptz' })
  fecha!: Date;

  @Column({ name: 'venta_id', type: 'uuid', nullable: true })
  ventaId!: string | null;
}
