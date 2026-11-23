import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Entradas de mercancía y sus renglones; cada renglón crea un lote. */
export class Entradas1792990836046 implements MigrationInterface {
  name = 'Entradas1792990836046';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE entrada (
        id          uuid           PRIMARY KEY,
        proveedor_id uuid          NOT NULL REFERENCES proveedor (id),
        folio_nota  varchar(40)    NOT NULL CHECK (btrim(folio_nota) <> ''),
        usuario_id  uuid           NOT NULL REFERENCES usuario (id),
        fecha       timestamptz    NOT NULL,
        total       numeric(12, 2) NOT NULL CHECK (total > 0)
      )`);
    // La misma nota de un proveedor no se puede capturar dos veces.
    await q.query(`CREATE UNIQUE INDEX entrada_nota ON entrada (proveedor_id, upper(folio_nota))`);
    await q.query(`CREATE INDEX entrada_fecha ON entrada (fecha)`);

    await q.query(`
      CREATE TABLE entrada_detalle (
        id             uuid           PRIMARY KEY,
        entrada_id     uuid           NOT NULL REFERENCES entrada (id),
        renglon        smallint       NOT NULL CHECK (renglon > 0),
        producto_id    uuid           NOT NULL REFERENCES producto (id),
        cantidad       numeric(10, 2) NOT NULL CHECK (cantidad > 0),
        costo_unitario numeric(12, 2) NOT NULL CHECK (costo_unitario > 0),
        importe        numeric(12, 2) NOT NULL CHECK (importe > 0),
        caducidad      date,
        lote_id        uuid           NOT NULL UNIQUE REFERENCES lote (id),
        UNIQUE (entrada_id, renglon)
      )`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE entrada_detalle`);
    await q.query(`DROP TABLE entrada`);
  }
}
