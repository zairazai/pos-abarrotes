import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Envíos por correo y Telegram: uno por destinatario y canal, con cómo le fue. Los que fallan se
 * quedan aquí para que el Dueño los pueda consultar.
 */
export class Envios1793000900000 implements MigrationInterface {
  name = 'Envios1793000900000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE envio (
        id           uuid         PRIMARY KEY,
        canal        varchar(8)   NOT NULL CHECK (canal IN ('CORREO', 'TELEGRAM')),
        tipo         varchar(11)  NOT NULL CHECK (tipo IN ('PROMOCION', 'RESUMEN_DIA')),
        destinatario varchar(254) NOT NULL,
        cliente_id   uuid REFERENCES cliente (id),
        asunto       varchar(120) NOT NULL,
        mensaje      text         NOT NULL,
        estado       varchar(9)   NOT NULL
          CHECK (estado IN ('PENDIENTE', 'ENVIADO', 'FALLIDO', 'CANCELADO')),
        intentos     smallint     NOT NULL DEFAULT 0,
        error        varchar(300),
        creado_en    timestamptz  NOT NULL,
        enviado_en   timestamptz
      )`);
    await q.query(`CREATE INDEX envio_estado ON envio (estado, creado_en)`);
    await q.query(`CREATE INDEX envio_cliente ON envio (cliente_id) WHERE estado = 'PENDIENTE'`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE envio`);
  }
}
