import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Promociones: mayoreo, NxM o precio especial, vigentes por días. Regla: el mismo producto no puede
 * tener dos promociones con fechas que se encimen; eso lo cuida la restricción EXCLUDE, y btree_gist
 * es lo que deja comparar el producto (=) junto con el rango de fechas (&&).
 */
export class Promociones1793000600000 implements MigrationInterface {
  name = 'Promociones1793000600000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE EXTENSION IF NOT EXISTS btree_gist`);
    await q.query(`
      CREATE TABLE promocion (
        id              uuid           PRIMARY KEY,
        producto_id     uuid           NOT NULL REFERENCES producto (id),
        tipo            varchar(15)    NOT NULL CHECK (tipo IN ('MAYOREO', 'NXM', 'PRECIO_ESPECIAL')),
        cantidad_minima numeric(10, 2) CHECK (cantidad_minima > 1),
        precio          numeric(12, 2) CHECK (precio > 0),
        lleva           smallint,
        paga            smallint,
        inicio          date           NOT NULL,
        fin             date           NOT NULL,
        estado          varchar(10)    NOT NULL CHECK (estado IN ('PROGRAMADA', 'ACTIVA', 'VENCIDA')),
        creada_por      uuid           NOT NULL REFERENCES usuario (id),
        creada_en       timestamptz    NOT NULL,
        CHECK (fin >= inicio),
        -- Cada tipo con sus condiciones y sin las de los otros.
        CHECK (
          (tipo = 'MAYOREO' AND cantidad_minima IS NOT NULL AND precio IS NOT NULL
            AND lleva IS NULL AND paga IS NULL)
          OR (tipo = 'NXM' AND lleva IS NOT NULL AND paga >= 1 AND paga < lleva
            AND cantidad_minima IS NULL AND precio IS NULL)
          OR (tipo = 'PRECIO_ESPECIAL' AND precio IS NOT NULL
            AND cantidad_minima IS NULL AND lleva IS NULL AND paga IS NULL)
        ),
        CONSTRAINT promocion_sin_traslape
          EXCLUDE USING gist (producto_id WITH =, daterange(inicio, fin, '[]') WITH &&)
      )`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE promocion`);
  }
}
