/** Entidades de devoluciones: la devolución, sus renglones y de qué lote se regresó cada unidad. */
import { Column, Entity, PrimaryColumn } from 'typeorm';
import type { Decimal, DestinoDevolucion, FormaReembolso } from '@pos/compartido';
import { columnaDecimal } from '../../infraestructura/base-datos/decimal';

const dinero = { type: 'numeric', precision: 12, scale: 2, transformer: columnaDecimal } as const;
const cantidad = { type: 'numeric', precision: 10, scale: 2, transformer: columnaDecimal } as const;

/**
 * Tabla `devolucion`: productos que regresan de una venta del día. Es 'TOTAL' si con ella ya no queda
 * nada por devolver (eso solo lo puede hacer el Dueño).
 */
@Entity('devolucion')
export class DevolucionEntidad {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'venta_id', type: 'uuid' })
  ventaId!: string;

  @Column({ name: 'caja_id', type: 'uuid' })
  cajaId!: string;

  @Column({ type: 'varchar', length: 7 })
  tipo!: 'PARCIAL' | 'TOTAL';

  @Column({ type: 'varchar', length: 100 })
  motivo!: string;

  // 'EFECTIVO' o 'SALDO_FAVOR' (cambio por producto).
  @Column({ name: 'forma_reembolso', type: 'varchar', length: 11 })
  formaReembolso!: FormaReembolso;

  // Efectivo que se le dio; con saldo a favor, cero.
  @Column(dinero)
  reembolso!: Decimal;

  @Column({ name: 'usuario_id', type: 'uuid' })
  usuarioId!: string;

  @Column({ type: 'timestamptz' })
  fecha!: Date;
}

/** Tabla `devolucion_detalle`: cuánto se devolvió de un renglón, lo que se pagó por eso y a dónde fue. */
@Entity('devolucion_detalle')
export class DevolucionDetalleEntidad {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'devolucion_id', type: 'uuid' })
  devolucionId!: string;

  @Column({ name: 'venta_detalle_id', type: 'uuid' })
  ventaDetalleId!: string;

  @Column(cantidad)
  cantidad!: Decimal;

  @Column(dinero)
  importe!: Decimal;

  @Column({ type: 'varchar', length: 10 })
  destino!: DestinoDevolucion;
}

/** Tabla `devolucion_lote`: a qué lote regresó cada unidad; si fue merma, la salida que la registra. */
@Entity('devolucion_lote')
export class DevolucionLoteEntidad {
  @PrimaryColumn({ name: 'devolucion_detalle_id', type: 'uuid' })
  devolucionDetalleId!: string;

  @PrimaryColumn({ name: 'lote_id', type: 'uuid' })
  loteId!: string;

  @Column(cantidad)
  cantidad!: Decimal;

  @Column({ name: 'salida_id', type: 'uuid', nullable: true })
  salidaId!: string | null;
}
