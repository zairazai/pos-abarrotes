import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Respaldos: una fila por cada pg_dump, con su archivo y cómo salió. El archivo vive en la carpeta de
 * respaldos; la fila se queda aunque el archivo ya se haya borrado.
 */
export class Respaldos1793001100000 implements MigrationInterface {
  name = 'Respaldos1793001100000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE respaldo (
        id           uuid         PRIMARY KEY,
        caja_id      uuid         REFERENCES caja (id),
        archivo      varchar(120) NOT NULL,
        bytes        bigint,
        estado       varchar(9)   NOT NULL CHECK (estado IN ('PENDIENTE', 'CORRECTO', 'FALLIDO')),
        error        varchar(300),
        creado_en    timestamptz  NOT NULL,
        terminado_en timestamptz
      )`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE respaldo`);
  }
}
