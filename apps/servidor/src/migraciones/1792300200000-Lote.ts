import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Lotes del inventario, con o sin caducidad. La existencia puede quedar en negativo porque se vende
 * aunque no haya (es regla); luego se corrige con el ajuste por conteo.
 */
export class Lote1792300200000 implements MigrationInterface {
  name = 'Lote1792300200000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE lote (
        id               uuid PRIMARY KEY,
        producto_id      uuid           NOT NULL REFERENCES producto (id),
        caducidad        date,
        existencia       numeric(10, 2) NOT NULL,
        cantidad_inicial numeric(10, 2) NOT NULL CHECK (cantidad_inicial >= 0),
        origen           varchar(8)     NOT NULL CHECK (origen IN ('ENTRADA', 'EJEMPLO', 'FALTANTE')),
        creado_en        timestamptz    NOT NULL
      )`);
    // Un lote FALTANTE (venta sin lotes) no tiene cantidad inicial ni caducidad.
    await q.query(`
      ALTER TABLE lote ADD CONSTRAINT lote_faltante
      CHECK (origen <> 'FALTANTE' OR (cantidad_inicial = 0 AND caducidad IS NULL))`);
    await q.query(`CREATE INDEX lote_producto ON lote (producto_id, caducidad)`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE lote`);
  }
}
