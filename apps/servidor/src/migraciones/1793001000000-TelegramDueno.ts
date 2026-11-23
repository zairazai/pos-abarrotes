import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Chat de Telegram del Dueño para sus avisos. Se llena cuando el Dueño le manda al bot el código de un
 * solo uso; mientras esté vacío, sus avisos solo salen por correo.
 */
export class TelegramDueno1793001000000 implements MigrationInterface {
  name = 'TelegramDueno1793001000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE configuracion_tienda ADD COLUMN telegram_dueno varchar(20)`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE configuracion_tienda DROP COLUMN telegram_dueno`);
  }
}
