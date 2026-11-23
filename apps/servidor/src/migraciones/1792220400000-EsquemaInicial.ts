import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Esquema inicial: usuarios, sesiones, bitácora y catálogo. Las reglas más delicadas también se
 * cuidan desde la base con CHECK, UNIQUE y llaves foráneas, por si acaso.
 */
export class EsquemaInicial1792220400000 implements MigrationInterface {
  name = 'EsquemaInicial1792220400000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE usuario (
        id               uuid PRIMARY KEY,
        nombre           varchar(80)  NOT NULL,
        rol              varchar(10)  NOT NULL CHECK (rol IN ('DUENO', 'EMPLEADO')),
        pin_hash         varchar(100) NOT NULL,
        modo_accesible   boolean      NOT NULL DEFAULT false,
        tamano_letra     smallint     NOT NULL DEFAULT 100 CHECK (tamano_letra BETWEEN 100 AND 300),
        activo           boolean      NOT NULL DEFAULT true,
        debe_cambiar_pin boolean      NOT NULL DEFAULT false,
        creado_en        timestamptz  NOT NULL DEFAULT now(),
        actualizado_en   timestamptz  NOT NULL DEFAULT now()
      )`);

    await q.query(`
      CREATE TABLE sesion (
        id          uuid PRIMARY KEY,
        usuario_id  uuid        NOT NULL REFERENCES usuario (id),
        token_hash  char(64)    NOT NULL UNIQUE,
        creada_en   timestamptz NOT NULL,
        expira_en   timestamptz NOT NULL,
        revocada_en timestamptz
      )`);
    await q.query(`CREATE INDEX sesion_usuario ON sesion (usuario_id)`);

    // Bitácora sin llave foránea a usuario y sin UPDATE ni DELETE: lo escrito, escrito está.
    await q.query(`
      CREATE TABLE bitacora (
        id         uuid PRIMARY KEY,
        fecha      timestamptz NOT NULL,
        usuario_id uuid,
        accion     varchar(40) NOT NULL,
        entidad    varchar(40) NOT NULL,
        entidad_id varchar(64),
        antes      jsonb,
        despues    jsonb
      )`);
    await q.query(`CREATE INDEX bitacora_fecha ON bitacora (fecha DESC)`);
    await q.query(`CREATE INDEX bitacora_accion ON bitacora (accion, fecha DESC)`);
    await q.query(`
      CREATE FUNCTION bitacora_inmutable() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'La bitácora no se puede modificar ni borrar';
      END $$`);
    await q.query(`
      CREATE TRIGGER bitacora_sin_cambios BEFORE UPDATE OR DELETE ON bitacora
      FOR EACH ROW EXECUTE FUNCTION bitacora_inmutable()`);

    await q.query(`
      CREATE TABLE categoria (
        id                 uuid PRIMARY KEY,
        nombre             varchar(60) NOT NULL,
        nombre_normalizado varchar(60) NOT NULL UNIQUE
      )`);

    // Sin ON DELETE CASCADE. Regla: no se puede borrar una categoría que todavía tiene productos.
    await q.query(`
      CREATE TABLE producto (
        id                 uuid PRIMARY KEY,
        codigo             varchar(30)    NOT NULL,
        nombre             varchar(120)   NOT NULL,
        nombre_normalizado varchar(120)   NOT NULL,
        unidad             varchar(5)     NOT NULL CHECK (unidad IN ('PIEZA', 'KG')),
        precio             numeric(12, 2) NOT NULL CHECK (precio > 0),
        costo              numeric(12, 2) NOT NULL CHECK (costo > 0),
        existencia_minima  numeric(10, 2) NOT NULL DEFAULT 0 CHECK (existencia_minima >= 0),
        categoria_id       uuid           NOT NULL REFERENCES categoria (id) ON DELETE RESTRICT,
        activo             boolean        NOT NULL DEFAULT true,
        creado_en          timestamptz    NOT NULL DEFAULT now(),
        actualizado_en     timestamptz    NOT NULL DEFAULT now(),
        desactivado_en     timestamptz
      )`);
    // El código es único sin importar mayúsculas, contando también los productos desactivados.
    await q.query(`CREATE UNIQUE INDEX producto_codigo ON producto (upper(codigo))`);
    await q.query(`CREATE INDEX producto_nombre ON producto (nombre_normalizado) WHERE activo`);
    await q.query(`CREATE INDEX producto_categoria ON producto (categoria_id)`);

    await q.query(`
      CREATE TABLE historial_precio (
        id              uuid PRIMARY KEY,
        producto_id     uuid           NOT NULL REFERENCES producto (id),
        precio_anterior numeric(12, 2) NOT NULL,
        precio_nuevo    numeric(12, 2) NOT NULL,
        fecha           timestamptz    NOT NULL,
        usuario_id      uuid REFERENCES usuario (id)
      )`);
    await q.query(`CREATE INDEX historial_precio_producto ON historial_precio (producto_id, fecha)`);

    // Categorías con las que arranca la tienda.
    await q.query(`
      INSERT INTO categoria (id, nombre, nombre_normalizado) VALUES
        (gen_random_uuid(), 'Abarrotes', 'abarrotes'),
        (gen_random_uuid(), 'Granel', 'granel'),
        (gen_random_uuid(), 'Bebidas', 'bebidas'),
        (gen_random_uuid(), 'Lácteos y salchichonería', 'lacteos y salchichoneria'),
        (gen_random_uuid(), 'Botanas y dulces', 'botanas y dulces'),
        (gen_random_uuid(), 'Panadería', 'panaderia'),
        (gen_random_uuid(), 'Limpieza', 'limpieza'),
        (gen_random_uuid(), 'Higiene personal', 'higiene personal')`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE historial_precio`);
    await q.query(`DROP TABLE producto`);
    await q.query(`DROP TABLE categoria`);
    await q.query(`DROP TRIGGER bitacora_sin_cambios ON bitacora`);
    await q.query(`DROP FUNCTION bitacora_inmutable`);
    await q.query(`DROP TABLE bitacora`);
    await q.query(`DROP TABLE sesion`);
    await q.query(`DROP TABLE usuario`);
  }
}
