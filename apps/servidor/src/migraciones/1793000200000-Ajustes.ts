import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Ajustes por conteo y cuánto cambió cada lote. */
export class Ajustes1793000200000 implements MigrationInterface {
  name = 'Ajustes1793000200000';

  async up(q: QueryRunner): Promise<void> {
    // Lote 'AJUSTE': lo que se contó de un producto que no tenía lotes; de ese no se sabe la caducidad.
    await q.query(`ALTER TABLE lote DROP CONSTRAINT lote_origen_check`);
    await q.query(`
      ALTER TABLE lote
        ADD CONSTRAINT lote_origen_check CHECK (origen IN ('ENTRADA', 'EJEMPLO', 'FALTANTE', 'AJUSTE')),
        ADD CONSTRAINT lote_ajuste CHECK (origen <> 'AJUSTE' OR caducidad IS NULL)`);

    await q.query(`
      CREATE TABLE ajuste (
        id          uuid           PRIMARY KEY,
        producto_id uuid           NOT NULL REFERENCES producto (id),
        registrada  numeric(10, 2) NOT NULL,
        contada     numeric(10, 2) NOT NULL CHECK (contada >= 0),
        diferencia  numeric(10, 2) NOT NULL CHECK (diferencia <> 0 AND diferencia = contada - registrada),
        usuario_id  uuid           NOT NULL REFERENCES usuario (id),
        fecha       timestamptz    NOT NULL
      )`);
    await q.query(`CREATE INDEX ajuste_fecha ON ajuste (fecha)`);

    await q.query(`
      CREATE TABLE ajuste_lote (
        ajuste_id uuid           NOT NULL REFERENCES ajuste (id),
        lote_id   uuid           NOT NULL REFERENCES lote (id),
        cambio    numeric(10, 2) NOT NULL CHECK (cambio <> 0),
        PRIMARY KEY (ajuste_id, lote_id)
      )`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE ajuste_lote`);
    await q.query(`DROP TABLE ajuste`);
    await q.query(`DELETE FROM lote WHERE origen = 'AJUSTE'`);
    await q.query(`
      ALTER TABLE lote
        DROP CONSTRAINT lote_ajuste,
        DROP CONSTRAINT lote_origen_check,
        ADD CONSTRAINT lote_origen_check CHECK (origen IN ('ENTRADA', 'EJEMPLO', 'FALTANTE'))`);
  }
}
