/**
 * Datos de ejemplo (npm run datos:ejemplo), para tener existencias mientras no hay entradas de
 * mercancía. Trae casos para probar las reglas: frijol con un lote caducado y otro bueno, leche por
 * caducar, lotes sin caducidad, productos a granel y un refresco sin lotes.
 */
import { randomUUID } from 'node:crypto';
import { Decimal, normalizarTexto, type ProductoNuevo } from '@pos/compartido';
import { fechaLocal } from '../../comun/fechas';
import { fuenteDatos } from '../../infraestructura/base-datos/fuente';
import { CatalogoServicio } from '../catalogo/catalogo';
import { CategoriaEntidad, ProductoEntidad } from '../catalogo/catalogo.tablas';
import { UsuariosServicio } from '../usuarios/usuarios';
import { UsuarioEntidad } from '../usuarios/usuarios.tablas';
import { LoteEntidad } from './inventario.tablas';

/** Lote de ejemplo: cantidad y días para caducar desde hoy (null si no caduca). */
interface LoteEjemplo {
  cantidad: string;
  caducaEnDias: number | null;
}

interface ProductoEjemplo extends Omit<ProductoNuevo, 'categoriaId'> {
  categoria: string;
  lotes: LoteEjemplo[];
}

/** Productos y lotes de demostración. */
const PRODUCTOS: ProductoEjemplo[] = [
  {
    codigo: '7501000111206',
    nombre: 'Frijol negro 1 kg',
    unidad: 'PIEZA',
    precio: '38.50',
    costo: '31.00',
    existenciaMinima: '5',
    categoria: 'Abarrotes',
    lotes: [
      { cantidad: '4', caducaEnDias: -2 },
      { cantidad: '10', caducaEnDias: 60 },
    ],
  },
  {
    codigo: '7501055300075',
    nombre: 'Leche entera 1 L',
    unidad: 'PIEZA',
    precio: '28.00',
    costo: '23.50',
    existenciaMinima: '6',
    categoria: 'Lácteos y salchichonería',
    lotes: [
      { cantidad: '6', caducaEnDias: 3 },
      { cantidad: '12', caducaEnDias: 10 },
    ],
  },
  {
    codigo: '7501030420017',
    nombre: 'Jabón de barra 250 g',
    unidad: 'PIEZA',
    precio: '22.00',
    costo: '17.00',
    existenciaMinima: '3',
    categoria: 'Higiene personal',
    lotes: [{ cantidad: '15', caducaEnDias: null }],
  },
  {
    codigo: 'GR-001',
    nombre: 'Azúcar estándar a granel',
    unidad: 'KG',
    precio: '30.00',
    costo: '24.00',
    existenciaMinima: '5',
    categoria: 'Granel',
    lotes: [{ cantidad: '12.50', caducaEnDias: null }],
  },
  {
    codigo: 'GR-002',
    nombre: 'Queso fresco a granel',
    unidad: 'KG',
    precio: '160.00',
    costo: '120.00',
    existenciaMinima: '1',
    categoria: 'Lácteos y salchichonería',
    lotes: [{ cantidad: '2.35', caducaEnDias: 5 }],
  },
  {
    codigo: '7501000123456',
    nombre: 'Refresco de cola 600 ml',
    unidad: 'PIEZA',
    precio: '18.00',
    costo: '13.00',
    existenciaMinima: '12',
    categoria: 'Bebidas',
    lotes: [],
  },
];

/** Suma días a un día AAAA-MM-DD. */
function sumarDias(dia: string, dias: number): string {
  const fecha = new Date(`${dia}T12:00:00Z`);
  fecha.setUTCDate(fecha.getUTCDate() + dias);
  return fecha.toISOString().slice(0, 10);
}

/**
 * Carga los productos de ejemplo con sus lotes; se salta los códigos que ya existen, así que se puede
 * correr varias veces sin problema. Regresa los nombres que agregó.
 */
export async function cargarDatosEjemplo(): Promise<string[]> {
  await new UsuariosServicio().asegurarDuenoInicial();
  const dueno = await fuenteDatos.getRepository(UsuarioEntidad).findOneByOrFail({ rol: 'DUENO' });
  const catalogo = new CatalogoServicio();
  const hoy = fechaLocal(new Date());
  const agregados: string[] = [];

  for (const { categoria, lotes, ...producto } of PRODUCTOS) {
    const existe = await fuenteDatos
      .getRepository(ProductoEntidad)
      .createQueryBuilder('p')
      .where('upper(p.codigo) = upper(:codigo)', { codigo: producto.codigo })
      .getExists();
    if (existe) continue;

    const { id: categoriaId } = await fuenteDatos
      .getRepository(CategoriaEntidad)
      .findOneByOrFail({ nombreNormalizado: normalizarTexto(categoria) });
    const registrado = await catalogo.registrarProducto({ ...producto, categoriaId }, dueno.id);
    for (const l of lotes) {
      await fuenteDatos.getRepository(LoteEntidad).insert({
        id: randomUUID(),
        productoId: registrado.id,
        caducidad: l.caducaEnDias === null ? null : sumarDias(hoy, l.caducaEnDias),
        existencia: new Decimal(l.cantidad),
        cantidadInicial: new Decimal(l.cantidad),
        origen: 'EJEMPLO',
        creadoEn: new Date(),
      });
    }
    agregados.push(producto.nombre);
  }
  return agregados;
}
