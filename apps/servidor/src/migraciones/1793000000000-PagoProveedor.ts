import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Pago a proveedor: un movimiento de efectivo ligado a su entrada. */
export class PagoProveedor1793000000000 implements MigrationInterface {
  name = 'PagoProveedor1793000000000';

  async up(q: QueryRunner): Promise<void> {
    // 'PAGO_PROVEEDOR' no cabe en varchar(10).
    await q.query(`ALTER TABLE movimiento_efectivo DROP CONSTRAINT movimiento_efectivo_tipo_check`);
    await q.query(`
      ALTER TABLE movimiento_efectivo
        ALTER COLUMN tipo TYPE varchar(15),
        ADD CONSTRAINT movimiento_efectivo_tipo_check
          CHECK (tipo IN ('RETIRO', 'INGRESO', 'VENTA', 'PAGO_PROVEEDOR')),
        ADD COLUMN entrada_id uuid REFERENCES entrada (id),
        ADD CONSTRAINT movimiento_efectivo_entrada CHECK ((tipo = 'PAGO_PROVEEDOR') = (entrada_id IS NOT NULL))`);
    // Una entrada se paga una sola vez.
    await q.query(`CREATE UNIQUE INDEX movimiento_efectivo_pago_entrada ON movimiento_efectivo (entrada_id)`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DELETE FROM movimiento_efectivo WHERE tipo = 'PAGO_PROVEEDOR'`);
    await q.query(`DROP INDEX movimiento_efectivo_pago_entrada`);
    await q.query(`
      ALTER TABLE movimiento_efectivo
        DROP CONSTRAINT movimiento_efectivo_entrada,
        DROP COLUMN entrada_id,
        DROP CONSTRAINT movimiento_efectivo_tipo_check,
        ADD CONSTRAINT movimiento_efectivo_tipo_check CHECK (tipo IN ('RETIRO', 'INGRESO', 'VENTA')),
        ALTER COLUMN tipo TYPE varchar(10)`);
  }
}
