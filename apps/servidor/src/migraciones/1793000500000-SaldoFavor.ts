import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Cambio por producto: la devolución se puede reembolsar como saldo a favor, que se usa una sola vez
 * como primer pago de una venta nueva del mismo día.
 */
export class SaldoFavor1793000500000 implements MigrationInterface {
  name = 'SaldoFavor1793000500000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE devolucion
        ADD COLUMN forma_reembolso varchar(11) NOT NULL DEFAULT 'EFECTIVO'
          CHECK (forma_reembolso IN ('EFECTIVO', 'SALDO_FAVOR'))`);
    await q.query(`
      CREATE TABLE saldo_favor (
        id            uuid           PRIMARY KEY,
        devolucion_id uuid           NOT NULL UNIQUE REFERENCES devolucion (id),
        monto         numeric(12, 2) NOT NULL CHECK (monto > 0),
        fecha         timestamptz    NOT NULL,
        venta_id      uuid           UNIQUE REFERENCES venta (id)
      )`);
    await q.query(`ALTER TABLE pago DROP CONSTRAINT pago_metodo_check`);
    await q.query(`
      ALTER TABLE pago ADD CONSTRAINT pago_metodo_check
        CHECK (metodo IN ('EFECTIVO', 'TARJETA', 'TRANSFERENCIA', 'SALDO_FAVOR'))`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DELETE FROM pago WHERE metodo = 'SALDO_FAVOR'`);
    await q.query(`ALTER TABLE pago DROP CONSTRAINT pago_metodo_check`);
    await q.query(`
      ALTER TABLE pago ADD CONSTRAINT pago_metodo_check
        CHECK (metodo IN ('EFECTIVO', 'TARJETA', 'TRANSFERENCIA'))`);
    await q.query(`DROP TABLE saldo_favor`);
    await q.query(`ALTER TABLE devolucion DROP COLUMN forma_reembolso`);
  }
}
