import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Mermas y consumo propio; cada salida descuenta de un solo lote. */
export class Salidas1793000100000 implements MigrationInterface {
  name = 'Salidas1793000100000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE salida (
        id          uuid           PRIMARY KEY,
        tipo        varchar(8)     NOT NULL CHECK (tipo IN ('MERMA', 'CONSUMO')),
        producto_id uuid           NOT NULL REFERENCES producto (id),
        lote_id     uuid           NOT NULL REFERENCES lote (id),
        cantidad    numeric(10, 2) NOT NULL CHECK (cantidad > 0),
        motivo      varchar(100)   NOT NULL CHECK (btrim(motivo) <> ''),
        comentario  varchar(300),
        usuario_id  uuid           NOT NULL REFERENCES usuario (id),
        fecha       timestamptz    NOT NULL
      )`);
    await q.query(`CREATE INDEX salida_fecha ON salida (fecha)`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE salida`);
  }
}
