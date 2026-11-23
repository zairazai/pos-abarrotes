/** Entidad de lotes: cuánta mercancía hay de cada producto y cuándo caduca. */
import { Column, Entity, PrimaryColumn } from 'typeorm';
import type { Decimal, TipoSalida } from '@pos/compartido';
import { columnaDecimal } from '../../infraestructura/base-datos/decimal';

/**
 * De dónde salió el lote: 'ENTRADA' (mercancía del proveedor), 'EJEMPLO' (datos de prueba), 'FALTANTE'
 * (se vendió un producto que no tenía lotes) o 'AJUSTE' (conteo de un producto sin lotes).
 */
export type OrigenLote = 'ENTRADA' | 'EJEMPLO' | 'FALTANTE' | 'AJUSTE';

/**
 * Tabla `lote`: piezas de un producto con la misma caducidad. La existencia de un producto es la
 * suma de sus lotes.
 */
@Entity('lote')
export class LoteEntidad {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'producto_id', type: 'uuid' })
  productoId!: string;

  // AAAA-MM-DD, o null si no caduca.
  @Column({ type: 'date', nullable: true })
  caducidad!: string | null;

  // Puede quedar negativa si se vendió más de lo que había (se permite, es regla).
  @Column({ type: 'numeric', precision: 10, scale: 2, transformer: columnaDecimal })
  existencia!: Decimal;

  // Cantidad con la que nació el lote.
  @Column({ name: 'cantidad_inicial', type: 'numeric', precision: 10, scale: 2, transformer: columnaDecimal })
  cantidadInicial!: Decimal;

  @Column({ type: 'varchar', length: 8 })
  origen!: OrigenLote;

  @Column({ name: 'creado_en', type: 'timestamptz' })
  creadoEn!: Date;
}

/** Tabla `entrada`: una nota de mercancía que llegó de un proveedor. */
@Entity('entrada')
export class EntradaEntidad {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'proveedor_id', type: 'uuid' })
  proveedorId!: string;

  // Folio de la nota del proveedor; no se repite para el mismo proveedor.
  @Column({ name: 'folio_nota', type: 'varchar', length: 40 })
  folioNota!: string;

  // Quién la capturó.
  @Column({ name: 'usuario_id', type: 'uuid' })
  usuarioId!: string;

  @Column({ type: 'timestamptz' })
  fecha!: Date;

  @Column({ type: 'numeric', precision: 12, scale: 2, transformer: columnaDecimal })
  total!: Decimal;
}

/** Tabla `entrada_detalle`: un renglón por producto; cada uno crea su lote. */
@Entity('entrada_detalle')
export class EntradaDetalleEntidad {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'entrada_id', type: 'uuid' })
  entradaId!: string;

  @Column({ type: 'smallint' })
  renglon!: number;

  @Column({ name: 'producto_id', type: 'uuid' })
  productoId!: string;

  @Column({ type: 'numeric', precision: 10, scale: 2, transformer: columnaDecimal })
  cantidad!: Decimal;

  @Column({ name: 'costo_unitario', type: 'numeric', precision: 12, scale: 2, transformer: columnaDecimal })
  costoUnitario!: Decimal;

  @Column({ type: 'numeric', precision: 12, scale: 2, transformer: columnaDecimal })
  importe!: Decimal; // cantidad × costo

  @Column({ type: 'date', nullable: true })
  caducidad!: string | null;

  @Column({ name: 'lote_id', type: 'uuid' })
  loteId!: string;
}

/**
 * Tabla `ejecucion_tarea`: una fila por cada tarea diaria hecha, con su resultado. Se apunta hasta el
 * final, así una tarea que truena a la mitad sigue como pendiente.
 */
@Entity('ejecucion_tarea')
export class EjecucionTareaEntidad {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 40 })
  tarea!: string;

  // Día de la tienda, AAAA-MM-DD.
  @Column({ type: 'date' })
  fecha!: string;

  @Column({ name: 'ejecutada_en', type: 'timestamptz' })
  ejecutadaEn!: Date;

  @Column({ type: 'jsonb' })
  resultado!: { porCaducar: number; caducados: number };
}

/** Tabla `salida`: merma o consumo propio de un lote, con su motivo. */
@Entity('salida')
export class SalidaEntidad {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 8 })
  tipo!: TipoSalida;

  @Column({ name: 'producto_id', type: 'uuid' })
  productoId!: string;

  @Column({ name: 'lote_id', type: 'uuid' })
  loteId!: string;

  @Column({ type: 'numeric', precision: 10, scale: 2, transformer: columnaDecimal })
  cantidad!: Decimal;

  @Column({ type: 'varchar', length: 100 })
  motivo!: string;

  @Column({ type: 'varchar', length: 300, nullable: true })
  comentario!: string | null;

  @Column({ name: 'usuario_id', type: 'uuid' })
  usuarioId!: string;

  @Column({ type: 'timestamptz' })
  fecha!: Date;
}

/** Tabla `ajuste`: corrección de la existencia de un producto según lo que se contó de verdad. */
@Entity('ajuste')
export class AjusteEntidad {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'producto_id', type: 'uuid' })
  productoId!: string;

  // Existencia antes del ajuste (suma de los lotes).
  @Column({ type: 'numeric', precision: 10, scale: 2, transformer: columnaDecimal })
  registrada!: Decimal;

  @Column({ type: 'numeric', precision: 10, scale: 2, transformer: columnaDecimal })
  contada!: Decimal;

  // contada - registrada (positivo: sobraba; negativo: faltaba).
  @Column({ type: 'numeric', precision: 10, scale: 2, transformer: columnaDecimal })
  diferencia!: Decimal;

  @Column({ name: 'usuario_id', type: 'uuid' })
  usuarioId!: string;

  @Column({ type: 'timestamptz' })
  fecha!: Date;
}

/** Tabla `ajuste_lote`: cuánto cambió cada lote en un ajuste. */
@Entity('ajuste_lote')
export class AjusteLoteEntidad {
  @PrimaryColumn({ name: 'ajuste_id', type: 'uuid' })
  ajusteId!: string;

  @PrimaryColumn({ name: 'lote_id', type: 'uuid' })
  loteId!: string;

  // Positivo suma, negativo resta.
  @Column({ type: 'numeric', precision: 10, scale: 2, transformer: columnaDecimal })
  cambio!: Decimal;
}
