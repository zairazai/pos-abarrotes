import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Catálogo de proveedores. */
export class Proveedores1792990030249 implements MigrationInterface {
  name = 'Proveedores1792990030249';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE proveedor (
        id                 uuid         PRIMARY KEY,
        nombre             varchar(80)  NOT NULL CHECK (btrim(nombre) <> ''),
        nombre_normalizado varchar(80)  NOT NULL UNIQUE,
        telefono           varchar(20)  NOT NULL DEFAULT '',
        creado_en          timestamptz  NOT NULL DEFAULT now(),
        creado_por         uuid         NOT NULL REFERENCES usuario (id)
      )`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE proveedor`);
  }
}
