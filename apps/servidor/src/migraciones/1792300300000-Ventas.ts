import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Ventas cobradas y canceladas, renglones, lotes vendidos y pagos. */
export class Ventas1792300300000 implements MigrationInterface {
  name = 'Ventas1792300300000';

  async up(q: QueryRunner): Promise<void> {
    // Folio consecutivo que nunca se reinicia; solo lo llevan las ventas cobradas.
    await q.query(`CREATE SEQUENCE venta_folio START 1`);

    await q.query(`
      CREATE TABLE venta (
        id                 uuid PRIMARY KEY,
        folio              integer UNIQUE,
        estado             varchar(9)     NOT NULL CHECK (estado IN ('COBRADA', 'CANCELADA')),
        caja_id            uuid           NOT NULL REFERENCES caja (id),
        iniciada_por       uuid           NOT NULL REFERENCES usuario (id),
        cobrada_por        uuid REFERENCES usuario (id),
        cancelada_por      uuid REFERENCES usuario (id),
        motivo_cancelacion varchar(8) CHECK (motivo_cancelacion IN ('EN_CURSO', 'CIERRE')),
        clave_idempotencia uuid UNIQUE,
        subtotal           numeric(12, 2) NOT NULL CHECK (subtotal >= 0),
        descuento_manual   numeric(12, 2) NOT NULL DEFAULT 0 CHECK (descuento_manual >= 0),
        total              numeric(12, 2) NOT NULL CHECK (total >= 0),
        redondeo           numeric(12, 2) NOT NULL DEFAULT 0 CHECK (redondeo >= 0 AND redondeo < 0.50),
        total_cobrado      numeric(12, 2) NOT NULL DEFAULT 0 CHECK (total_cobrado >= 0),
        cambio             numeric(12, 2) NOT NULL DEFAULT 0 CHECK (cambio >= 0),
        ticket_emitido     boolean        NOT NULL DEFAULT false,
        fecha              timestamptz    NOT NULL,
        CHECK (total = subtotal - descuento_manual),
        CHECK (
          (estado = 'COBRADA' AND folio IS NOT NULL AND cobrada_por IS NOT NULL
            AND clave_idempotencia IS NOT NULL AND motivo_cancelacion IS NULL)
          OR (estado = 'CANCELADA' AND folio IS NULL AND motivo_cancelacion IS NOT NULL)
        ),
        -- Al cerrar cancela el sistema (sin usuario); en pantalla, quien la canceló.
        CHECK (motivo_cancelacion IS DISTINCT FROM 'EN_CURSO' OR cancelada_por IS NOT NULL)
      )`);
    await q.query(`CREATE INDEX venta_caja ON venta (caja_id, estado)`);

    // Se copian nombre y precio para que el ticket no cambie aunque después cambie el catálogo.
    await q.query(`
      CREATE TABLE venta_detalle (
        id               uuid PRIMARY KEY,
        venta_id         uuid           NOT NULL REFERENCES venta (id),
        renglon          smallint       NOT NULL,
        producto_id      uuid           NOT NULL REFERENCES producto (id),
        nombre           varchar(120)   NOT NULL,
        unidad           varchar(5)     NOT NULL CHECK (unidad IN ('PIEZA', 'KG')),
        precio           numeric(12, 2) NOT NULL CHECK (precio > 0),
        cantidad         numeric(10, 2) NOT NULL CHECK (cantidad > 0),
        importe          numeric(12, 2) NOT NULL CHECK (importe > 0),
        descuento_manual numeric(12, 2) NOT NULL DEFAULT 0 CHECK (descuento_manual BETWEEN 0 AND importe),
        UNIQUE (venta_id, renglon)
      )`);

    // Lotes de cada renglón; sirven para regresar la mercancía a su lote en una devolución.
    await q.query(`
      CREATE TABLE venta_detalle_lote (
        venta_detalle_id uuid           NOT NULL REFERENCES venta_detalle (id),
        lote_id          uuid           NOT NULL REFERENCES lote (id),
        cantidad         numeric(10, 2) NOT NULL CHECK (cantidad > 0),
        PRIMARY KEY (venta_detalle_id, lote_id)
      )`);

    // Pagos. Regla: con tarjeta o transferencia, la referencia es obligatoria.
    await q.query(`
      CREATE TABLE pago (
        id         uuid PRIMARY KEY,
        venta_id   uuid           NOT NULL REFERENCES venta (id),
        metodo     varchar(13)    NOT NULL CHECK (metodo IN ('EFECTIVO', 'TARJETA', 'TRANSFERENCIA')),
        monto      numeric(12, 2) NOT NULL CHECK (monto > 0),
        referencia varchar(40),
        CHECK (metodo = 'EFECTIVO' OR referencia IS NOT NULL)
      )`);

    // El efectivo de cada venta entra a la caja como movimiento de tipo VENTA.
    await q.query(`ALTER TABLE movimiento_efectivo DROP CONSTRAINT movimiento_efectivo_tipo_check`);
    await q.query(`
      ALTER TABLE movimiento_efectivo
        ADD CONSTRAINT movimiento_efectivo_tipo_check CHECK (tipo IN ('RETIRO', 'INGRESO', 'VENTA')),
        ADD COLUMN venta_id uuid REFERENCES venta (id),
        ADD CONSTRAINT movimiento_efectivo_venta CHECK ((tipo = 'VENTA') = (venta_id IS NOT NULL))`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DELETE FROM movimiento_efectivo WHERE tipo = 'VENTA'`);
    await q.query(`
      ALTER TABLE movimiento_efectivo
        DROP CONSTRAINT movimiento_efectivo_venta,
        DROP COLUMN venta_id,
        DROP CONSTRAINT movimiento_efectivo_tipo_check,
        ADD CONSTRAINT movimiento_efectivo_tipo_check CHECK (tipo IN ('RETIRO', 'INGRESO'))`);
    await q.query(`DROP TABLE pago`);
    await q.query(`DROP TABLE venta_detalle_lote`);
    await q.query(`DROP TABLE venta_detalle`);
    await q.query(`DROP TABLE venta`);
    await q.query(`DROP SEQUENCE venta_folio`);
  }
}
