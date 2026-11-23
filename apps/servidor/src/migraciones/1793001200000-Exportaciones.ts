import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Exportaciones de reportes: una fila por cada PDF o Excel que se pide, con su periodo y cómo salió.
 * El archivo vive 30 días en la carpeta de reportes; la fila se queda.
 */
export class Exportaciones1793001200000 implements MigrationInterface {
  name = 'Exportaciones1793001200000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE exportacion (
        id           uuid         PRIMARY KEY,
        tipo         varchar(13)  NOT NULL CHECK (tipo IN ('ventas', 'ganancia', 'mas-vendidos', 'cortes',
                                    'inventario', 'mermas', 'cancelaciones', 'empleados')),
        formato      varchar(5)   NOT NULL CHECK (formato IN ('PDF', 'EXCEL')),
        desde        date         NOT NULL,
        hasta        date         NOT NULL CHECK (hasta >= desde),
        estado       varchar(9)   NOT NULL CHECK (estado IN ('PENDIENTE', 'LISTO', 'FALLIDO')),
        archivo      varchar(120) NOT NULL,
        bytes        bigint,
        error        varchar(300),
        usuario_id   uuid         NOT NULL REFERENCES usuario (id),
        creado_en    timestamptz  NOT NULL,
        terminado_en timestamptz
      )`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE exportacion`);
  }
}
