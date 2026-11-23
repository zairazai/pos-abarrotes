/** Entidad de proveedores: a quién se le compra la mercancía. */
import { Column, Entity, PrimaryColumn } from 'typeorm';

/** Tabla `proveedor`. */
@Entity('proveedor')
export class ProveedorEntidad {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 80 })
  nombre!: string;

  // Nombre sin acentos ni mayúsculas; es único para no dar de alta dos veces al mismo proveedor.
  @Column({ name: 'nombre_normalizado', type: 'varchar', length: 80, unique: true })
  nombreNormalizado!: string;

  @Column({ type: 'varchar', length: 20 })
  telefono!: string;

  @Column({ name: 'creado_en', type: 'timestamptz' })
  creadoEn!: Date;

  // Quién lo dio de alta.
  @Column({ name: 'creado_por', type: 'uuid' })
  creadoPor!: string;
}
