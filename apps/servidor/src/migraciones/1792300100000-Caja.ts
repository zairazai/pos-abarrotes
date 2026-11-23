import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Caja del día, movimientos de efectivo y arqueos. */
export class Caja1792300100000 implements MigrationInterface {
  name = 'Caja1792300100000';

  async up(q: QueryRunner): Promise<void> {
    // Regla: una caja por día (UNIQUE en fecha) y solo una abierta a la vez (índice parcial).
    await q.query(`
      CREATE TABLE caja (
        id             uuid PRIMARY KEY,
        fecha          date           NOT NULL UNIQUE,
        estado         varchar(8)     NOT NULL CHECK (estado IN ('ABIERTA', 'CERRADA')),
        fondo_inicial  numeric(12, 2) NOT NULL CHECK (fondo_inicial >= 0),
        conteo_fondo   jsonb,
        abierta_por    uuid           NOT NULL REFERENCES usuario (id),
        abierta_en     timestamptz    NOT NULL,
        cerrada_por    uuid REFERENCES usuario (id),
        cerrada_en     timestamptz,
        efectivo_final numeric(12, 2) CHECK (efectivo_final >= 0),
        diferencia     numeric(12, 2),
        justificacion  varchar(300),
        CHECK (
          (estado = 'ABIERTA' AND cerrada_en IS NULL AND efectivo_final IS NULL)
          OR (estado = 'CERRADA' AND cerrada_por IS NOT NULL AND cerrada_en IS NOT NULL
              AND efectivo_final IS NOT NULL AND diferencia IS NOT NULL)
        ),
        -- Regla: si el cierre tiene diferencia, lleva justificación.
        CHECK (diferencia IS NULL OR diferencia = 0 OR justificacion IS NOT NULL)
      )`);
    await q.query(`CREATE UNIQUE INDEX caja_una_abierta ON caja (estado) WHERE estado = 'ABIERTA'`);

    await q.query(`
      CREATE TABLE movimiento_efectivo (
        id         uuid PRIMARY KEY,
        caja_id    uuid           NOT NULL REFERENCES caja (id),
        tipo       varchar(10)    NOT NULL CHECK (tipo IN ('RETIRO', 'INGRESO')),
        monto      numeric(12, 2) NOT NULL CHECK (monto > 0),
        motivo     varchar(200)   NOT NULL CHECK (btrim(motivo) <> ''),
        usuario_id uuid           NOT NULL REFERENCES usuario (id),
        fecha      timestamptz    NOT NULL
      )`);
    await q.query(`CREATE INDEX movimiento_efectivo_caja ON movimiento_efectivo (caja_id, fecha)`);

    // Regla: máximo dos conteos por caja, el original y un reconteo.
    await q.query(`
      CREATE TABLE arqueo (
        id         uuid PRIMARY KEY,
        caja_id    uuid           NOT NULL REFERENCES caja (id),
        intento    smallint       NOT NULL CHECK (intento IN (1, 2)),
        resultado  varchar(10)    NOT NULL CHECK (resultado IN ('CUADRA', 'RECONTAR', 'JUSTIFICAR')),
        contado    numeric(12, 2) NOT NULL CHECK (contado >= 0),
        esperado   numeric(12, 2) NOT NULL,
        diferencia numeric(12, 2) NOT NULL,
        usuario_id uuid           NOT NULL REFERENCES usuario (id),
        fecha      timestamptz    NOT NULL,
        UNIQUE (caja_id, intento)
      )`);

    await q.query(`
      CREATE TABLE arqueo_denominacion (
        arqueo_id uuid          NOT NULL REFERENCES arqueo (id),
        clave     varchar(5)    NOT NULL,
        valor     numeric(7, 2) NOT NULL CHECK (valor > 0),
        cantidad  integer       NOT NULL CHECK (cantidad >= 0),
        PRIMARY KEY (arqueo_id, clave)
      )`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE arqueo_denominacion`);
    await q.query(`DROP TABLE arqueo`);
    await q.query(`DROP TABLE movimiento_efectivo`);
    await q.query(`DROP TABLE caja`);
  }
}
