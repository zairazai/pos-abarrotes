import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Devoluciones de ventas del día: la devolución, sus renglones y a qué lote regresó cada unidad. El
 * reembolso sale de la caja como movimiento DEVOLUCION.
 */
export class Devoluciones1793000400000 implements MigrationInterface {
  name = 'Devoluciones1793000400000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE devolucion (
        id         uuid           PRIMARY KEY,
        venta_id   uuid           NOT NULL REFERENCES venta (id),
        caja_id    uuid           NOT NULL REFERENCES caja (id),
        tipo       varchar(7)     NOT NULL CHECK (tipo IN ('PARCIAL', 'TOTAL')),
        motivo     varchar(100)   NOT NULL CHECK (btrim(motivo) <> ''),
        reembolso  numeric(12, 2) NOT NULL CHECK (reembolso >= 0),
        usuario_id uuid           NOT NULL REFERENCES usuario (id),
        fecha      timestamptz    NOT NULL
      )`);
    await q.query(`CREATE INDEX devolucion_venta ON devolucion (venta_id)`);

    await q.query(`
      CREATE TABLE devolucion_detalle (
        id               uuid           PRIMARY KEY,
        devolucion_id    uuid           NOT NULL REFERENCES devolucion (id),
        venta_detalle_id uuid           NOT NULL REFERENCES venta_detalle (id),
        cantidad         numeric(10, 2) NOT NULL CHECK (cantidad > 0),
        importe          numeric(12, 2) NOT NULL CHECK (importe >= 0),
        destino          varchar(10)    NOT NULL CHECK (destino IN ('INVENTARIO', 'MERMA'))
      )`);
    await q.query(`CREATE INDEX devolucion_detalle_venta ON devolucion_detalle (venta_detalle_id)`);

    // Si se fue a merma, la salida que la registra.
    await q.query(`
      CREATE TABLE devolucion_lote (
        devolucion_detalle_id uuid           NOT NULL REFERENCES devolucion_detalle (id),
        lote_id               uuid           NOT NULL REFERENCES lote (id),
        cantidad              numeric(10, 2) NOT NULL CHECK (cantidad > 0),
        salida_id             uuid REFERENCES salida (id),
        PRIMARY KEY (devolucion_detalle_id, lote_id)
      )`);

    await q.query(`ALTER TABLE movimiento_efectivo DROP CONSTRAINT movimiento_efectivo_tipo_check`);
    await q.query(`
      ALTER TABLE movimiento_efectivo
        ADD CONSTRAINT movimiento_efectivo_tipo_check
          CHECK (tipo IN ('RETIRO', 'INGRESO', 'VENTA', 'PAGO_PROVEEDOR', 'DEVOLUCION')),
        ADD COLUMN devolucion_id uuid REFERENCES devolucion (id),
        ADD CONSTRAINT movimiento_efectivo_devolucion
          CHECK ((tipo = 'DEVOLUCION') = (devolucion_id IS NOT NULL))`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DELETE FROM movimiento_efectivo WHERE tipo = 'DEVOLUCION'`);
    await q.query(`
      ALTER TABLE movimiento_efectivo
        DROP CONSTRAINT movimiento_efectivo_devolucion,
        DROP COLUMN devolucion_id,
        DROP CONSTRAINT movimiento_efectivo_tipo_check,
        ADD CONSTRAINT movimiento_efectivo_tipo_check
          CHECK (tipo IN ('RETIRO', 'INGRESO', 'VENTA', 'PAGO_PROVEEDOR'))`);
    await q.query(`DROP TABLE devolucion_lote`);
    await q.query(`DROP TABLE devolucion_detalle`);
    await q.query(`DROP TABLE devolucion`);
  }
}
