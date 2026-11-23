import { expect } from 'chai';
import { randomUUID } from 'node:crypto';
import { Decimal } from '@pos/compartido';
import { fuenteDatos } from '../../src/infraestructura/base-datos/fuente';
import { conTransaccion } from '../../src/infraestructura/base-datos/transaccion';
import { CatalogoServicio } from '../../src/modulos/catalogo/catalogo';
import { cargarDatosEjemplo } from '../../src/modulos/inventario/datos-ejemplo';
import { LoteEntidad } from '../../src/modulos/inventario/inventario.tablas';
import { InventarioServicio } from '../../src/modulos/inventario/inventario';
import { appDePrueba, limpiarBase, productoValido } from '../ayuda';

const inventario = new InventarioServicio();
const lotes = () => fuenteDatos.getRepository(LoteEntidad);

async function productoNuevo(codigo = 'ABC-1', unidad: 'PIEZA' | 'KG' = 'PIEZA'): Promise<string> {
  const [categoria] = await fuenteDatos.query(`SELECT id FROM categoria WHERE nombre = 'Abarrotes'`);
  const producto = await new CatalogoServicio().registrarProducto(
    {
      codigo,
      nombre: `Producto ${codigo}`,
      unidad,
      precio: '25.00',
      costo: '20.00',
      existenciaMinima: '0',
      categoriaId: categoria.id,
    },
    randomUUID(),
  );
  return producto.id;
}

/** Crea un lote de ejemplo; `creadoEn` sirve para desempatar lotes con la misma caducidad. */
async function lote(
  productoId: string,
  caducidad: string | null,
  existencia: string,
  creadoEn = '2026-10-01T12:00:00Z',
): Promise<string> {
  const id = randomUUID();
  await lotes().insert({
    id,
    productoId,
    caducidad,
    existencia: new Decimal(existencia),
    cantidadInicial: new Decimal(existencia),
    origen: 'EJEMPLO',
    creadoEn: new Date(creadoEn),
  });
  return id;
}

/** Descuenta en su propia transacción, como lo hará el cobro. */
function descontar(productoId: string, cantidad: string) {
  return conTransaccion((manager) => inventario.descontarPorCaducidad(manager, productoId, cantidad));
}

async function existenciaDe(loteId: string): Promise<string> {
  return (await lotes().findOneByOrFail({ id: loteId })).existencia.toFixed(2);
}

describe('Núcleo de inventario', () => {
  beforeEach(limpiarBase);

  describe('descuento por caducidad', () => {
    it('descuenta primero del lote que caduca antes, aunque ya haya caducado', async () => {
      const id = await productoNuevo();
      const lejano = await lote(id, '2026-12-01', '10');
      const caducado = await lote(id, '2026-10-10', '2');
      const sinCaducidad = await lote(id, null, '5');

      const r = await descontar(id, '3');
      expect(r.faltante.toFixed(2)).to.equal('0.00');
      expect(r.consumos.map((c) => [c.loteId, c.cantidad.toFixed(2)])).to.deep.equal([
        [caducado, '2.00'],
        [lejano, '1.00'],
      ]);
      expect(await existenciaDe(caducado)).to.equal('0.00');
      expect(await existenciaDe(lejano)).to.equal('9.00');
      expect(await existenciaDe(sinCaducidad)).to.equal('5.00');
    });

    it('con la misma caducidad descuenta primero el lote más antiguo', async () => {
      const id = await productoNuevo();
      const nuevo = await lote(id, '2026-11-01', '5', '2026-10-15T12:00:00Z');
      const viejo = await lote(id, '2026-11-01', '5', '2026-10-01T12:00:00Z');
      await descontar(id, '1');
      expect(await existenciaDe(viejo)).to.equal('4.00');
      expect(await existenciaDe(nuevo)).to.equal('5.00');
    });

    it('descuenta kilos a granel con 2 decimales', async () => {
      const id = await productoNuevo('GR-1', 'KG');
      const a = await lote(id, '2026-10-20', '0.75');
      const b = await lote(id, '2026-10-25', '3.40');
      await descontar(id, '1.25');
      expect(await existenciaDe(a)).to.equal('0.00');
      expect(await existenciaDe(b)).to.equal('2.90');
      expect((await inventario.existencia(id)).toFixed(2)).to.equal('2.90');
    });
  });

  describe('venta sin existencias', () => {
    it('el faltante deja negativo el último lote del orden y la venta sigue', async () => {
      const id = await productoNuevo();
      const proximo = await lote(id, '2026-10-20', '1');
      const ultimo = await lote(id, '2026-11-20', '1');
      const r = await descontar(id, '5');
      expect(r.faltante.toFixed(2)).to.equal('3.00');
      expect(await existenciaDe(proximo)).to.equal('0.00');
      expect(await existenciaDe(ultimo)).to.equal('-3.00');
      expect((await inventario.existencia(id)).toFixed(2)).to.equal('-3.00');
    });

    it('un producto sin lotes recibe un lote FALTANTE en negativo, y el siguiente faltante se suma ahí', async () => {
      const id = await productoNuevo();
      const primero = await descontar(id, '2');
      expect(primero.faltante.toFixed(2)).to.equal('2.00');
      const creados = await lotes().findBy({ productoId: id });
      expect(creados).to.have.length(1);
      expect(creados[0]).to.include({ origen: 'FALTANTE', caducidad: null });
      expect(creados[0]!.existencia.toFixed(2)).to.equal('-2.00');
      expect(primero.consumos[0]!.loteId).to.equal(creados[0]!.id);

      await descontar(id, '1');
      expect(await lotes().countBy({ productoId: id })).to.equal(1);
      expect((await inventario.existencia(id)).toFixed(2)).to.equal('-3.00');
    });
  });

  describe('transacciones y concurrencia', () => {
    it('si el cobro falla después de descontar, las existencias no cambian', async () => {
      const id = await productoNuevo();
      const l = await lote(id, '2026-11-01', '10');
      const error = await conTransaccion(async (manager) => {
        await inventario.descontarPorCaducidad(manager, id, '4');
        throw new Error('falla simulada del cobro');
      }).catch((e: Error) => e);
      expect(error).to.be.instanceOf(Error);
      expect(await existenciaDe(l)).to.equal('10.00');
    });

    it('si el cobro falla en un producto sin lotes, no queda el lote FALTANTE', async () => {
      const id = await productoNuevo();
      await conTransaccion(async (manager) => {
        await inventario.descontarPorCaducidad(manager, id, '1');
        throw new Error('falla simulada del cobro');
      }).catch(() => undefined);
      expect(await lotes().countBy({ productoId: id })).to.equal(0);
    });

    it('dos cobros al mismo tiempo se forman en fila y no descuentan dos veces del mismo lote', async () => {
      const id = await productoNuevo();
      const proximo = await lote(id, '2026-10-20', '3');
      const despues = await lote(id, '2026-11-20', '10');

      // El primer cobro descuenta y deja su transacción abierta mientras empieza el segundo.
      let avisarDescontado!: () => void;
      let terminarPrimero!: () => void;
      const descontado = new Promise<void>((r) => (avisarDescontado = r));
      const puedeTerminar = new Promise<void>((r) => (terminarPrimero = r));
      const primero = conTransaccion(async (manager) => {
        await inventario.descontarPorCaducidad(manager, id, '3');
        avisarDescontado();
        await puedeTerminar;
      });
      await descontado;
      // Sin el candado, el segundo vería el lote próximo todavía con 3 y descontaría de él otra vez.
      const segundo = descontar(id, '3');
      await new Promise((r) => setTimeout(r, 200));
      terminarPrimero();
      await Promise.all([primero, segundo]);

      expect(await existenciaDe(proximo)).to.equal('0.00');
      expect(await existenciaDe(despues)).to.equal('7.00');
    });
  });

  describe('existencias', () => {
    it('suma los lotes de cada producto; sin lotes la existencia es cero', async () => {
      const conLotes = await productoNuevo('A-1');
      const sinLotes = await productoNuevo('A-2');
      await lote(conLotes, '2026-11-01', '2.5');
      await lote(conLotes, null, '4');
      const mapa = await inventario.existencias([conLotes, sinLotes]);
      expect(mapa.get(conLotes)!.toFixed(2)).to.equal('6.50');
      expect(mapa.get(sinLotes)!.toFixed(2)).to.equal('0.00');
      expect((await inventario.existencias([])).size).to.equal(0);
    });

    it('el catálogo devuelve la existencia al buscar por código, consultar y listar', async () => {
      const { api } = await appDePrueba();
      const [categoria] = await fuenteDatos.query(`SELECT id FROM categoria WHERE nombre = 'Abarrotes'`);
      const creado = await api
        .post('/api/v1/productos')
        .send({ ...productoValido, categoriaId: categoria.id })
        .expect(201);
      const id = creado.body.data.id as string;
      expect(creado.body.data).to.not.have.property('existencia');

      const sinLotes = await api.get(`/api/v1/productos/codigo/${productoValido.codigo}`).expect(200);
      expect(sinLotes.body.data.existencia).to.equal('0.00');

      await lote(id, '2026-11-01', '7');
      await lote(id, null, '3');
      const porCodigo = await api.get(`/api/v1/productos/codigo/${productoValido.codigo}`).expect(200);
      expect(porCodigo.body.data.existencia).to.equal('10.00');
      const porId = await api.get(`/api/v1/productos/${id}`).expect(200);
      expect(porId.body.data.existencia).to.equal('10.00');
      const lista = await api.get('/api/v1/productos').expect(200);
      expect(lista.body.data[0].existencia).to.equal('10.00');
    });
  });

  describe('datos de ejemplo', () => {
    it('cargan productos con lotes variados y no se duplican al correrlos otra vez', async () => {
      const agregados = await cargarDatosEjemplo();
      expect(agregados).to.have.length(6);
      expect(await cargarDatosEjemplo()).to.deep.equal([]);

      const filas: { codigo: string; caducidad: string | null; existencia: string }[] =
        await fuenteDatos.query(
          `SELECT p.codigo, l.caducidad::text AS caducidad, l.existencia
           FROM lote l JOIN producto p ON p.id = l.producto_id ORDER BY p.codigo, l.caducidad`,
        );
      expect(filas.filter((f) => f.codigo === '7501000111206')).to.deep.equal([
        { codigo: '7501000111206', caducidad: '2026-10-15', existencia: '4.00' },
        { codigo: '7501000111206', caducidad: '2026-12-16', existencia: '10.00' },
      ]);
      expect(filas.find((f) => f.codigo === 'GR-001')).to.include({ caducidad: null, existencia: '12.50' });
      expect(filas.some((f) => f.codigo === '7501000123456')).to.equal(false);
      expect(filas.every((f) => f.existencia !== null)).to.equal(true);
    });
  });

  describe('reglas que defiende PostgreSQL', () => {
    it('un lote FALTANTE no tiene cantidad inicial ni caducidad', async () => {
      const id = await productoNuevo();
      const error = await lotes()
        .insert({
          id: randomUUID(),
          productoId: id,
          caducidad: '2026-11-01',
          existencia: new Decimal(-1),
          cantidadInicial: new Decimal(0),
          origen: 'FALTANTE',
          creadoEn: new Date(),
        })
        .catch((e: Error) => e);
      expect(error).to.be.instanceOf(Error);
      expect((error as Error).message).to.match(/lote_faltante/);
    });
  });
});
