/** Entidad de los respaldos de la base de datos. */
import { Column, Entity, PrimaryColumn } from 'typeorm';
import type { EstadoRespaldo } from '@pos/compartido';

/** Tabla `respaldo`: un pg_dump con su archivo y cómo salió. */
@Entity('respaldo')
export class RespaldoEntidad {
  @PrimaryColumn('uuid')
  id!: string;

  // La caja que, al cerrarse, lo pidió.
  @Column({ name: 'caja_id', type: 'uuid', nullable: true })
  cajaId!: string | null;

  // Solo el nombre; la carpeta sale del .env.
  @Column({ type: 'varchar', length: 120 })
  archivo!: string;

  // bigint llega como texto desde PostgreSQL.
  @Column({ type: 'bigint', nullable: true })
  bytes!: string | null;

  @Column({ type: 'varchar', length: 9 })
  estado!: EstadoRespaldo;

  @Column({ type: 'varchar', length: 300, nullable: true })
  error!: string | null;

  @Column({ name: 'creado_en', type: 'timestamptz' })
  creadoEn!: Date;

  @Column({ name: 'terminado_en', type: 'timestamptz', nullable: true })
  terminadoEn!: Date | null;
}
