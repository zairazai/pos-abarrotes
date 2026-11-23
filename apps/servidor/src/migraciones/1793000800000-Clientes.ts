import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Clientes: solo correo y/o teléfono y la vinculación con Telegram; nada de nombre ni historial de
 * compras (es regla, por privacidad). Cada vez que acepta el aviso es una fila de consentimiento; la
 * baja la revoca y como mucho hay una vigente.
 */
export class Clientes1793000800000 implements MigrationInterface {
  name = 'Clientes1793000800000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE cliente (
        id               uuid         PRIMARY KEY,
        correo           varchar(254) UNIQUE,
        telefono         varchar(15)  UNIQUE,
        telegram_chat_id varchar(20)  UNIQUE,
        creado_en        timestamptz  NOT NULL,
        CHECK (correo IS NOT NULL OR telefono IS NOT NULL)
      )`);
    await q.query(`
      CREATE TABLE consentimiento (
        id          uuid        PRIMARY KEY,
        cliente_id  uuid        NOT NULL REFERENCES cliente (id),
        origen      varchar(8)  NOT NULL CHECK (origen IN ('CAJA', 'TELEGRAM')),
        aceptado_en timestamptz NOT NULL,
        revocado_en timestamptz
      )`);
    await q.query(`
      CREATE UNIQUE INDEX consentimiento_vigente ON consentimiento (cliente_id) WHERE revocado_en IS NULL`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE consentimiento`);
    await q.query(`DROP TABLE cliente`);
  }
}
