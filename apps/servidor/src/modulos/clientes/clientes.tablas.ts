/** Entidades de clientes: el contacto y sus consentimientos. */
import { Column, Entity, PrimaryColumn } from 'typeorm';

/** Tabla `cliente`. Regla: solo lo necesario para mandarle promociones, nada más. */
@Entity('cliente')
export class ClienteEntidad {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 254, nullable: true })
  correo!: string | null;

  @Column({ type: 'varchar', length: 15, nullable: true })
  telefono!: string | null;

  // Su chat con el bot; null si todavía no se liga.
  @Column({ name: 'telegram_chat_id', type: 'varchar', length: 20, nullable: true })
  telegramChatId!: string | null;

  @Column({ name: 'creado_en', type: 'timestamptz' })
  creadoEn!: Date;
}

/** Tabla `consentimiento`: cada vez que acepta el aviso de privacidad; la baja lo revoca. */
@Entity('consentimiento')
export class ConsentimientoEntidad {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'cliente_id', type: 'uuid' })
  clienteId!: string;

  // 'CAJA' o 'TELEGRAM': por dónde aceptó.
  @Column({ type: 'varchar', length: 8 })
  origen!: 'CAJA' | 'TELEGRAM';

  @Column({ name: 'aceptado_en', type: 'timestamptz' })
  aceptadoEn!: Date;

  @Column({ name: 'revocado_en', type: 'timestamptz', nullable: true })
  revocadoEn!: Date | null;
}
