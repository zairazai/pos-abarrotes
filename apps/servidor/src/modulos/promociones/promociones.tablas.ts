/** Entidad de promociones. */
import { Column, Entity, PrimaryColumn } from 'typeorm';
import type { Decimal, EstadoPromocion } from '@pos/compartido';
import { columnaDecimal } from '../../infraestructura/base-datos/decimal';

/**
 * Tabla `promocion`. Regla: una por producto y periodo, sin que las fechas se encimen. Las condiciones
 * que su tipo no usa se quedan en null.
 */
@Entity('promocion')
export class PromocionEntidad {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'producto_id', type: 'uuid' })
  productoId!: string;

  @Column({ type: 'varchar', length: 15 })
  tipo!: 'MAYOREO' | 'NXM' | 'PRECIO_ESPECIAL';

  // Mayoreo: desde cuántas unidades aplica.
  @Column({
    name: 'cantidad_minima',
    type: 'numeric',
    precision: 10,
    scale: 2,
    nullable: true,
    transformer: columnaDecimal,
  })
  cantidadMinima!: Decimal | null;

  // Mayoreo y precio especial.
  @Column({ type: 'numeric', precision: 12, scale: 2, nullable: true, transformer: columnaDecimal })
  precio!: Decimal | null;

  // NxM: lleva N y paga M.
  @Column({ type: 'smallint', nullable: true })
  lleva!: number | null;

  @Column({ type: 'smallint', nullable: true })
  paga!: number | null;

  // Días de vigencia, AAAA-MM-DD, incluidos.
  @Column({ type: 'date' })
  inicio!: string;

  @Column({ type: 'date' })
  fin!: string;

  // Lo actualiza el worker cuando la promoción se activa o vence.
  @Column({ type: 'varchar', length: 10 })
  estado!: EstadoPromocion;

  @Column({ name: 'creada_por', type: 'uuid' })
  creadaPor!: string;

  @Column({ name: 'creada_en', type: 'timestamptz' })
  creadaEn!: Date;
}
