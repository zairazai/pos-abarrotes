import { expect } from 'chai';
import sinon from 'sinon';
import { randomUUID } from 'node:crypto';
import { Decimal, normalizarTexto } from '@pos/compartido';
import { fuenteDatos } from '../../src/infraestructura/base-datos/fuente';
import { BitacoraServicio } from '../../src/modulos/bitacora/bitacora';
import { CatalogoServicio } from '../../src/modulos/catalogo/catalogo';
import { HistorialPrecioEntidad, ProductoEntidad } from '../../src/modulos/catalogo/catalogo.tablas';
import { limpiarBase, registrosBitacora } from '../ayuda';

const USUARIO = randomUUID();

async function categoriaAbarrotes(): Promise<string> {
  const [fila] = await fuenteDatos.query(`SELECT id FROM categoria WHERE nombre = 'Abarrotes'`);
  return fila.id;
}

/** Producto listo para guardar directo con TypeORM, sin pasar por las validaciones del servicio. */
function producto(categoriaId: string, datos: Partial<ProductoEntidad> = {}): ProductoEntidad {
  const nombre = datos.nombre ?? 'Frijol negro 1 kg';
  return fuenteDatos.getRepository(ProductoEntidad).create({
    id: randomUUID(),
    codigo: '7501000111206',
    nombre,
    nombreNormalizado: normalizarTexto(nombre),
    unidad: 'PIEZA',
    precio: new Decimal('38.50'),
    costo: new Decimal('31.00'),
    existenciaMinima: new Decimal('5'),
    categoriaId,
    activo: true,
    creadoEn: new Date(),
    actualizadoEn: new Date(),
    desactivadoEn: null,
    ...datos,
  });
}

describe('Integridad en PostgreSQL', () => {
  let categoriaId: string;
  const catalogo = new CatalogoServicio();
  const productos = () => fuenteDatos.getRepository(ProductoEntidad);
  const nuevo = () => ({
    codigo: 'ABC-1',
    nombre: 'Arroz 1 kg',
    unidad: 'PIEZA' as const,
    precio: '25.00',
    costo: '20.00',
    existenciaMinima: '3',
    categoriaId,
  });

  beforeEach(async () => {
    await limpiarBase();
    categoriaId = await categoriaAbarrotes();
  });

  afterEach(() => sinon.restore());

  describe('operaciones completas o nada', () => {
    it('si falla la bitácora al registrar un producto, el producto no queda guardado', async () => {
      sinon.stub(BitacoraServicio.prototype, 'registrar').rejects(new Error('falla simulada'));
      const error = await catalogo.registrarProducto(nuevo(), USUARIO).catch((e: Error) => e);
      expect(error).to.be.instanceOf(Error);
      expect(await productos().findOneBy({ codigo: 'ABC-1' })).to.equal(null);
    });

    it('si falla a mitad del cambio de precio, no queda ni el precio, ni el historial, ni la bitácora', async () => {
      const creado = await catalogo.registrarProducto(nuevo(), USUARIO);
      // La bitácora es el último paso: el historial y el precio ya se escribieron dentro de la transacción.
      sinon.stub(BitacoraServicio.prototype, 'registrar').rejects(new Error('falla simulada'));
      const error = await catalogo
        .cambiarPrecio(creado.id, { precio: '27.00' }, USUARIO)
        .catch((e: Error) => e);
      expect(error).to.be.instanceOf(Error);
      sinon.restore();
      expect((await productos().findOneBy({ id: creado.id }))!.precio.toFixed(2)).to.equal('25.00');
      expect(
        await fuenteDatos.getRepository(HistorialPrecioEntidad).countBy({ productoId: creado.id }),
      ).to.equal(0);
      expect((await registrosBitacora({ accion: 'PRODUCTO_PRECIO' })).total).to.equal(0);
    });

    it('si todo sale bien, el producto y su bitácora quedan guardados juntos', async () => {
      await catalogo.registrarProducto(nuevo(), USUARIO);
      expect(await catalogo.productoActivoPorCodigo('abc-1')).to.not.equal(null);
      expect((await registrosBitacora({ accion: 'PRODUCTO_REGISTRADO' })).total).to.equal(1);
    });
  });

  describe('bitácora inalterable', () => {
    beforeEach(async () => {
      await new BitacoraServicio().registrar({
        usuarioId: USUARIO,
        accion: 'ACCESO',
        entidad: 'sesion',
        despues: { ok: true },
      });
    });

    it('rechaza UPDATE aunque se haga directo en la base', async () => {
      const error = await fuenteDatos.query(`UPDATE bitacora SET accion = 'OTRA'`).catch((e: Error) => e);
      expect((error as Error).message).to.match(/no se puede modificar ni borrar/);
    });

    it('rechaza DELETE aunque se haga directo en la base', async () => {
      const error = await fuenteDatos.query(`DELETE FROM bitacora`).catch((e: Error) => e);
      expect((error as Error).message).to.match(/no se puede modificar ni borrar/);
      expect((await registrosBitacora()).total).to.equal(1);
    });

    it('guarda los valores anteriores y nuevos como JSON', async () => {
      const { registros } = await registrosBitacora();
      expect(registros[0]!.despues).to.deep.equal({ ok: true });
    });
  });

  describe('reglas que defiende la base de datos', () => {
    it('guarda montos con NUMERIC y los devuelve como Decimal exacto', async () => {
      const p = producto(categoriaId, { precio: new Decimal('0.10').plus('0.20') });
      await productos().save(p);
      const leido = await productos().findOneBy({ id: p.id });
      expect(leido!.precio).to.be.instanceOf(Decimal);
      expect(leido!.precio.toFixed(2)).to.equal('0.30');
    });

    it('no admite dos productos con el mismo código aunque cambien las mayúsculas', async () => {
      await productos().save(producto(categoriaId, { codigo: 'gr-arroz' }));
      const error = await productos()
        .save(producto(categoriaId, { codigo: 'GR-ARROZ' }))
        .catch((e: Error) => e);
      expect((error as Error).message).to.match(/producto_codigo/);
    });

    it('no permite borrar una categoría con productos', async () => {
      await productos().save(producto(categoriaId));
      const error = await fuenteDatos
        .query('DELETE FROM categoria WHERE id = $1', [categoriaId])
        .catch((e: Error) => e);
      expect((error as Error).message).to.match(/foreign key|llave foránea/i);
    });

    it('rechaza un precio de cero aunque se salte la validación de la API', async () => {
      const error = await productos()
        .save(producto(categoriaId, { precio: new Decimal(0) }))
        .catch((e: Error) => e);
      expect((error as Error).message).to.match(/check constraint|restricción/i);
    });

    it('busca sin acentos y trata los comodines de LIKE como texto', async () => {
      await productos().save(producto(categoriaId, { codigo: 'A1', nombre: 'Jamón de pavo' }));
      await productos().save(producto(categoriaId, { codigo: 'A2', nombre: 'Queso 100% de vaca' }));
      const jamon = await catalogo.listarProductos({ buscar: 'JAMON', page: 1, limit: 10 });
      expect(jamon.productos.map((p) => p.nombre)).to.deep.equal(['Jamón de pavo']);
      const porcentaje = await catalogo.listarProductos({ buscar: '%', page: 1, limit: 10 });
      expect(porcentaje.productos.map((p) => p.nombre)).to.deep.equal(['Queso 100% de vaca']);
    });
  });
});
