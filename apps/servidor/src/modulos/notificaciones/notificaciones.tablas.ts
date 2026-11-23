/** Entidad de los envíos por correo y Telegram. */
import { Column, Entity, PrimaryColumn } from 'typeorm';
import type { CanalEnvio, EstadoEnvio } from '@pos/compartido';

/** Tabla `envio`: un mensaje por destinatario y canal, con cómo le fue. */
@Entity('envio')
export class EnvioEntidad {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 8 })
  canal!: CanalEnvio;

  @Column({ type: 'varchar', length: 11 })
  tipo!: 'PROMOCION' | 'RESUMEN_DIA';

  // Correo o chat de Telegram.
  @Column({ type: 'varchar', length: 254 })
  destinatario!: string;

  // null en los avisos al Dueño.
  @Column({ name: 'cliente_id', type: 'uuid', nullable: true })
  clienteId!: string | null;

  @Column({ type: 'varchar', length: 120 })
  asunto!: string;

  @Column({ type: 'text' })
  mensaje!: string;

  @Column({ type: 'varchar', length: 9 })
  estado!: EstadoEnvio;

  @Column({ type: 'smallint' })
  intentos!: number;

  @Column({ type: 'varchar', length: 300, nullable: true })
  error!: string | null;

  @Column({ name: 'creado_en', type: 'timestamptz' })
  creadoEn!: Date;

  @Column({ name: 'enviado_en', type: 'timestamptz', nullable: true })
  enviadoEn!: Date | null;
}
