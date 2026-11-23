/** Entidad de las exportaciones de reportes a PDF o Excel. */
import { Column, Entity, PrimaryColumn } from 'typeorm';
import type { FormatoExportacion, TipoReporte } from '@pos/compartido';

/** Tabla `exportacion`: el archivo lo hace el worker; la fila guarda el pedido y cómo salió. */
@Entity('exportacion')
export class ExportacionEntidad {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 13 })
  tipo!: TipoReporte;

  @Column({ type: 'varchar', length: 5 })
  formato!: FormatoExportacion;

  // Periodo ya resuelto, en días de la tienda (AAAA-MM-DD).
  @Column({ type: 'date' })
  desde!: string;

  @Column({ type: 'date' })
  hasta!: string;

  @Column({ type: 'varchar', length: 9 })
  estado!: 'PENDIENTE' | 'LISTO' | 'FALLIDO';

  @Column({ type: 'varchar', length: 120 })
  archivo!: string;

  // bigint llega como texto desde PostgreSQL.
  @Column({ type: 'bigint', nullable: true })
  bytes!: string | null;

  @Column({ type: 'varchar', length: 300, nullable: true })
  error!: string | null;

  // Quien la pidió; a esa persona se le avisa cuando está lista.
  @Column({ name: 'usuario_id', type: 'uuid' })
  usuarioId!: string;

  @Column({ name: 'creado_en', type: 'timestamptz' })
  creadoEn!: Date;

  @Column({ name: 'terminado_en', type: 'timestamptz', nullable: true })
  terminadoEn!: Date | null;
}
