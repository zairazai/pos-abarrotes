import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Datos de la tienda que salen en el ticket. */
export class Configuracion1792300000000 implements MigrationInterface {
  name = 'Configuracion1792300000000';

  async up(q: QueryRunner): Promise<void> {
    // El CHECK sobre id deja que exista una sola fila.
    await q.query(`
      CREATE TABLE configuracion_tienda (
        id                  smallint     PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        nombre              varchar(80)  NOT NULL CHECK (btrim(nombre) <> ''),
        direccion           varchar(160) NOT NULL DEFAULT '',
        telefono            varchar(20)  NOT NULL DEFAULT '',
        politica_devolucion varchar(300) NOT NULL CHECK (btrim(politica_devolucion) <> ''),
        enlace_bot          varchar(200) NOT NULL DEFAULT '',
        actualizado_en      timestamptz  NOT NULL DEFAULT now(),
        actualizado_por     uuid REFERENCES usuario (id)
      )`);
    // Valores de arranque; el Dueño los cambia después.
    await q.query(`
      INSERT INTO configuracion_tienda (nombre, politica_devolucion) VALUES
        ('Tienda de abarrotes', 'Devoluciones el mismo día de la compra presentando este ticket.')`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE configuracion_tienda`);
  }
}
