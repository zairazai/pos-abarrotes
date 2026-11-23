/** Entidad de la configuración: los datos de la tienda que salen en el ticket. */
import { Column, Entity, PrimaryColumn } from 'typeorm';

/** Tabla `configuracion_tienda`, con una sola fila (id = 1) que crea la migración. */
@Entity('configuracion_tienda')
export class ConfiguracionEntidad {
  @PrimaryColumn('smallint')
  id!: number;

  @Column({ type: 'varchar', length: 80 })
  nombre!: string;

  @Column({ type: 'varchar', length: 160 })
  direccion!: string;

  @Column({ type: 'varchar', length: 20 })
  telefono!: string;

  // Texto al final del ticket, por ejemplo "Devoluciones solo el mismo día".
  @Column({ name: 'politica_devolucion', type: 'varchar', length: 300 })
  politicaDevolucion!: string;

  // Enlace al bot de Telegram; va en el QR del ticket.
  @Column({ name: 'enlace_bot', type: 'varchar', length: 200 })
  enlaceBot!: string;

  // Chat de Telegram del Dueño para sus avisos; lo pone el bot cuando recibe el código de un solo uso.
  @Column({ name: 'telegram_dueno', type: 'varchar', length: 20, nullable: true })
  telegramDueno!: string | null;

  @Column({ name: 'actualizado_en', type: 'timestamptz' })
  actualizadoEn!: Date;

  // Quién hizo el último cambio.
  @Column({ name: 'actualizado_por', type: 'uuid', nullable: true })
  actualizadoPor!: string | null;
}
