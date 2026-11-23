import { expect } from 'chai';
import {
  esquemaProductoNuevo,
  esquemaProductoModificado,
  esquemaCambioPrecio,
  esquemaCategoriaNueva,
  esquemaConsultaProductos,
} from '../../src/esquemas/catalogo';

const valido = {
  codigo: '7501000111206',
  nombre: 'Frijol negro 1 kg',
  unidad: 'PIEZA',
  precio: '38.50',
  costo: '31.00',
  existenciaMinima: '5',
  categoriaId: '3f1c2b8e-8a4d-4c55-9a77-6c1d2f0e9b10',
};

describe('Esquemas del catálogo', () => {
  it('acepta un producto completo y quita espacios del nombre', () => {
    const r = esquemaProductoNuevo.parse({ ...valido, nombre: '  Frijol negro 1 kg ' });
    expect(r.nombre).to.equal('Frijol negro 1 kg');
  });

  it('rechaza precio o costo que no sean positivos', () => {
    expect(esquemaProductoNuevo.safeParse({ ...valido, precio: '0' }).success).to.equal(false);
    expect(esquemaProductoNuevo.safeParse({ ...valido, costo: '0.00' }).success).to.equal(false);
  });

  it('rechaza montos con más de 2 decimales o con formato inválido', () => {
    expect(esquemaProductoNuevo.safeParse({ ...valido, precio: '18.505' }).success).to.equal(false);
    expect(esquemaProductoNuevo.safeParse({ ...valido, precio: '18,50' }).success).to.equal(false);
  });

  it('solo acepta las unidades pieza y kilogramo', () => {
    expect(esquemaProductoNuevo.safeParse({ ...valido, unidad: 'LITRO' }).success).to.equal(false);
    expect(esquemaProductoNuevo.safeParse({ ...valido, unidad: 'KG' }).success).to.equal(true);
  });

  it('acepta existencia mínima de cero', () => {
    expect(esquemaProductoNuevo.safeParse({ ...valido, existenciaMinima: '0' }).success).to.equal(true);
  });

  it('indica el campo exacto que falta', () => {
    const { codigo: _omitido, ...sinCodigo } = valido;
    const r = esquemaProductoNuevo.safeParse(sinCodigo);
    expect(r.success).to.equal(false);
    expect(r.error!.issues[0]!.path).to.deep.equal(['codigo']);
  });

  it('la modificación no admite el precio, que se cambia aparte', () => {
    const r = esquemaProductoModificado.safeParse(valido);
    expect(r.success).to.equal(false);
  });

  it('el cambio de precio exige un precio positivo', () => {
    expect(esquemaCambioPrecio.safeParse({ precio: '40.00' }).success).to.equal(true);
    expect(esquemaCambioPrecio.safeParse({ precio: '-1' }).success).to.equal(false);
  });

  it('la categoría exige un nombre', () => {
    expect(esquemaCategoriaNueva.safeParse({ nombre: '   ' }).success).to.equal(false);
  });

  it('la consulta de productos convierte page y limit y les da valores por defecto', () => {
    expect(esquemaConsultaProductos.parse({})).to.deep.equal({ page: 1, limit: 20 });
    expect(esquemaConsultaProductos.parse({ page: '2', limit: '5', buscar: 'frijol' })).to.deep.equal({
      page: 2,
      limit: 5,
      buscar: 'frijol',
    });
    expect(esquemaConsultaProductos.safeParse({ limit: '500' }).success).to.equal(false);
  });
});
