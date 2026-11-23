import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Promociones aplicadas al cobrar: cada renglón guarda cuánto descontó y con qué promoción, y la venta
 * guarda el ahorro total, que sale en el ticket. Desde aquí el total también resta ese ahorro.
 */
export class PromocionesEnVenta1793000700000 implements MigrationInterface {
  name = 'PromocionesEnVenta1793000700000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE venta
        ADD COLUMN ahorro_promociones numeric(12, 2) NOT NULL DEFAULT 0 CHECK (ahorro_promociones >= 0),
        DROP CONSTRAINT venta_check,
        ADD CONSTRAINT venta_total_calculado CHECK (total = subtotal - ahorro_promociones - descuento_manual)`);
    await q.query(`
      ALTER TABLE venta_detalle
        ADD COLUMN descuento_promocion numeric(12, 2) NOT NULL DEFAULT 0 CHECK (descuento_promocion >= 0),
        ADD COLUMN promocion_id uuid REFERENCES promocion (id)`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE venta_detalle
        DROP COLUMN promocion_id,
        DROP COLUMN descuento_promocion`);
    await q.query(`
      ALTER TABLE venta
        DROP CONSTRAINT venta_total_calculado,
        DROP COLUMN ahorro_promociones,
        ADD CONSTRAINT venta_check CHECK (total = subtotal - descuento_manual)`);
  }
}
