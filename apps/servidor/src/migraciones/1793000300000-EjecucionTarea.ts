import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Tareas diarias que ya se hicieron, como la revisión de caducidades. */
export class EjecucionTarea1793000300000 implements MigrationInterface {
  name = 'EjecucionTarea1793000300000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE ejecucion_tarea (
        id           uuid        PRIMARY KEY,
        tarea        varchar(40) NOT NULL,
        fecha        date        NOT NULL,
        ejecutada_en timestamptz NOT NULL,
        resultado    jsonb       NOT NULL,
        CONSTRAINT ejecucion_tarea_dia UNIQUE (tarea, fecha)
      )`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE ejecucion_tarea`);
  }
}
