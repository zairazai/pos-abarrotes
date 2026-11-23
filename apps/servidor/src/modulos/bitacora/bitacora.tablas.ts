/** Entidad de la bitácora: quién hizo qué y cuándo. */
import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * Tabla `bitacora`. Solo se le puede agregar: un disparador de PostgreSQL rechaza cualquier UPDATE o
 * DELETE.
 */
@Entity('bitacora')
export class BitacoraEntidad {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'timestamptz' })
  fecha!: Date;

  // null cuando no se sabe quién fue (por ejemplo, un PIN incorrecto).
  @Column({ name: 'usuario_id', type: 'uuid', nullable: true })
  usuarioId!: string | null;

  // Por ejemplo 'PRODUCTO_REGISTRADO' o 'ACCESO_FALLIDO'.
  @Column({ type: 'varchar', length: 40 })
  accion!: string;

  // Tabla afectada, por ejemplo 'producto'.
  @Column({ type: 'varchar', length: 40 })
  entidad!: string;

  // Id del registro afectado.
  @Column({ name: 'entidad_id', type: 'varchar', length: 64, nullable: true })
  entidadId!: string | null;

  // Cómo estaba antes y cómo quedó después, en jsonb.
  @Column({ type: 'jsonb', nullable: true })
  antes!: object | null;

  @Column({ type: 'jsonb', nullable: true })
  despues!: object | null;
}
