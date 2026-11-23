/**
 * Entidades del catálogo: categoría, producto e historial de precios.
 * Las entidades van en un archivo aparte porque fuente.ts las importa al arrancar y catalogo.ts
 * importa la conexión; si estuvieran juntas, se importarían en círculo (igual en todos los módulos).
 */
import { Column, Entity, PrimaryColumn } from 'typeorm';
import type { Decimal, Unidad } from '@pos/compartido';
import { columnaDecimal } from '../../infraestructura/base-datos/decimal';

/** Tabla `categoria`. */
@Entity('categoria')
export class CategoriaEntidad {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 60 })
  nombre!: string;

  // Nombre en minúsculas y sin acentos; es único para que no existan "Panadería" y "PANADERIA" a la vez.
  @Column({ name: 'nombre_normalizado', type: 'varchar', length: 60, unique: true })
  nombreNormalizado!: string;
}

/** Tabla `producto`. Regla: los productos no se borran, se desactivan. */
@Entity('producto')
export class ProductoEntidad {
  @PrimaryColumn('uuid')
  id!: string;

  // Código de barras, o código interno en los productos a granel.
  @Column({ type: 'varchar', length: 30 })
  codigo!: string;

  @Column({ type: 'varchar', length: 120 })
  nombre!: string;

  // Para buscar sin importar acentos ni mayúsculas.
  @Column({ name: 'nombre_normalizado', type: 'varchar', length: 120 })
  nombreNormalizado!: string;

  // 'PIEZA' o 'KG' (granel).
  @Column({ type: 'varchar', length: 5 })
  unidad!: Unidad;

  // Montos en NUMERIC para no perder centavos.
  @Column({ type: 'numeric', precision: 12, scale: 2, transformer: columnaDecimal })
  precio!: Decimal;

  @Column({ type: 'numeric', precision: 12, scale: 2, transformer: columnaDecimal })
  costo!: Decimal;

  // Si hay esta cantidad o menos, se avisa que hay que resurtir.
  @Column({
    name: 'existencia_minima',
    type: 'numeric',
    precision: 10,
    scale: 2,
    transformer: columnaDecimal,
  })
  existenciaMinima!: Decimal;

  @Column({ name: 'categoria_id', type: 'uuid' })
  categoriaId!: string;

  // Un producto desactivado ya no se vende, pero sigue apareciendo en las ventas viejas.
  @Column({ type: 'boolean' })
  activo!: boolean;

  @Column({ name: 'creado_en', type: 'timestamptz' })
  creadoEn!: Date;

  @Column({ name: 'actualizado_en', type: 'timestamptz' })
  actualizadoEn!: Date;

  @Column({ name: 'desactivado_en', type: 'timestamptz', nullable: true })
  desactivadoEn!: Date | null;
}

/** Tabla `historial_precio`. Regla: cada cambio de precio queda apuntado. */
@Entity('historial_precio')
export class HistorialPrecioEntidad {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'producto_id', type: 'uuid' })
  productoId!: string;

  @Column({ name: 'precio_anterior', type: 'numeric', precision: 12, scale: 2, transformer: columnaDecimal })
  precioAnterior!: Decimal;

  @Column({ name: 'precio_nuevo', type: 'numeric', precision: 12, scale: 2, transformer: columnaDecimal })
  precioNuevo!: Decimal;

  @Column({ type: 'timestamptz' })
  fecha!: Date;

  // Quién hizo el cambio.
  @Column({ name: 'usuario_id', type: 'uuid', nullable: true })
  usuarioId!: string | null;
}
