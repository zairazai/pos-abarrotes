import { expect } from 'chai';
import sinon from 'sinon';
import { fuenteDatos } from '../../src/infraestructura/base-datos/fuente';
import { InventarioServicio } from '../../src/modulos/inventario/inventario';
import { appDePrueba, productoValido, type Api } from '../ayuda';

/**
 * Hoy es 2026-10-17 (reloj de las pruebas). Frijol (mínimo 5) con un lote caducado, uno que caduca
 * en 7 días, uno en 8 días y uno "No aplica"; arroz (mínimo 5) con 20 piezas sin caducidad.
 */
async function preparar(api: Api) {
  const [categoria] = await fuenteDatos.query(`SELECT id FROM categoria WHERE nombre = 'Abarrotes'`);
  const frijol = await api
    .post('/api/v1/productos')
    .send({ ...productoValido, existenciaMinima: '5', categoriaId: categoria.id })
    .expect(201);
  const arroz = await api
    .post('/api/v1/productos')
    .send({
      ...productoValido,
      codigo: '7501000000099',
      nombre: 'Arroz 1 kg',
      existenciaMinima: '5',
      categoriaId: categoria.id,
    })
    .expect(201);
  const proveedor = await api.post('/api/v1/proveedores').send({ nombre: 'La Costeña' }).expect(201);
  const renglon = (productoId: string, cantidad: string, caducidad: string | null) => ({
    productoId,
    cantidad,
    costoUnitario: '30',
    caducidad,
  });
  const entrada = await api
    .post('/api/v1/inventario/entradas')
    .send({
      proveedorId: proveedor.body.data.id,
      folioNota: 'E-1',
      renglones: [
        renglon(frijol.body.data.id, '1', '2026-10-25'),
        renglon(frijol.body.data.id, '1', '2026-10-24'),
        renglon(frijol.body.data.id, '1', '2026-10-15'),
        renglon(frijol.body.data.id, '1', null),
        renglon(arroz.body.data.id, '20', null),
      ],
    })
    .expect(201);
  const [ocho, siete, caducado, noAplica] = entrada.body.data.renglones.map(
    (r: { loteId: string }) => r.loteId,
  );
  return {
    frijolId: frijol.body.data.id as string,
    arrozId: arroz.body.data.id as string,
    ocho,
    siete,
    caducado,
    noAplica,
  };
}

describe('Existencias y alertas de inventario', () => {
  it('muestra la existencia, la mínima y los lotes del que caduca primero al último', async () => {
    const { api, empleado } = await appDePrueba();
    const p = await preparar(api);
    const res = await empleado.get(`/api/v1/inventario/existencias/${p.frijolId}`).expect(200);

    expect(res.body.data).to.include({ existencia: '4.00', existenciaMinima: '5.00', enMinimo: true });
    expect(res.body.data.producto).to.include({ nombre: 'Frijol negro 1 kg', unidad: 'PIEZA' });
    expect(
      res.body.data.lotes.map((l: { id: string; diasParaCaducar: number | null }) => [
        l.id,
        l.diasParaCaducar,
      ]),
    ).to.deep.equal([
      [p.caducado, -2],
      [p.siete, 7],
      [p.ocho, 8],
      [p.noAplica, null],
    ]);
  });

  it('refleja mermas y no muestra los lotes que quedaron en cero', async () => {
    const { api } = await appDePrueba();
    const p = await preparar(api);
    await api
      .post('/api/v1/inventario/salidas')
      .send({ tipo: 'MERMA', productoId: p.frijolId, cantidad: '1', motivo: 'Caducado' })
      .expect(201);
    const res = await api.get(`/api/v1/inventario/existencias/${p.frijolId}`).expect(200);
    expect(res.body.data.existencia).to.equal('3.00');
    expect(res.body.data.lotes.map((l: { id: string }) => l.id)).to.not.include(p.caducado);
  });

  it('responde 404 si el producto no existe', async () => {
    const { api } = await appDePrueba();
    await api.get('/api/v1/inventario/existencias/3f1c2b8e-8a4d-4c55-9a77-6c1d2f0e9b10').expect(404);
  });

  it('alerta la existencia mínima y los lotes que caducan en 7 días o menos, incluidos los caducados', async () => {
    const { api, empleado } = await appDePrueba();
    const p = await preparar(api);
    const res = await empleado.get('/api/v1/inventario/alertas').expect(200);

    expect(res.body.data.fecha).to.equal('2026-10-17');
    expect(res.body.data.minimo).to.deep.equal([
      {
        productoId: p.frijolId,
        nombre: 'Frijol negro 1 kg',
        unidad: 'PIEZA',
        existencia: '4.00',
        existenciaMinima: '5.00',
      },
    ]);
    expect(
      res.body.data.caducidad.map((a: { loteId: string; caducado: boolean }) => [a.loteId, a.caducado]),
    ).to.deep.equal([
      [p.caducado, true],
      [p.siete, false],
    ]);
  });

  it('sin alertas lo indica (1a)', async () => {
    const { api } = await appDePrueba();
    const res = await api.get('/api/v1/inventario/alertas').expect(200);
    expect(res.body.message).to.equal('No hay alertas de inventario');
    expect(res.body.data.minimo).to.deep.equal([]);
    expect(res.body.data.caducidad).to.deep.equal([]);
  });

  describe('resumen al abrir la caja', () => {
    const abrir = (api: Api) =>
      api
        .post('/api/v1/caja/apertura')
        .send({ fondoInicial: { B100: 5 } })
        .expect(201);

    afterEach(() => sinon.restore());

    it('la apertura trae los conteos y la frase para leer', async () => {
      const { api } = await appDePrueba();
      await preparar(api);
      const res = await abrir(api);
      expect(res.body.data.estado).to.equal('ABIERTA');
      expect(res.body.data.alertas).to.deep.equal({
        minimo: 1,
        porCaducar: 1,
        caducados: 1,
        mensaje: '1 producto en existencia mínima, 1 lote por caducar y 1 lote caducado',
      });
    });

    it('sin alertas lo dice', async () => {
      const { api } = await appDePrueba();
      const res = await abrir(api);
      expect(res.body.data.alertas).to.deep.equal({
        minimo: 0,
        porCaducar: 0,
        caducados: 0,
        mensaje: 'Sin alertas de inventario',
      });
    });

    it('si el cálculo falla, la caja abre igual y alertas viene en null', async () => {
      const { api } = await appDePrueba();
      sinon.stub(InventarioServicio.prototype, 'resumenAlertas').rejects(new Error('sin conexión'));
      sinon.stub(console, 'error');
      const res = await abrir(api);
      expect(res.body.data.alertas).to.equal(null);
      const actual = await api.get('/api/v1/caja/actual').expect(200);
      expect(actual.body.data.caja.estado).to.equal('ABIERTA');
    });
  });

  it('los productos desactivados no generan alertas', async () => {
    const { api } = await appDePrueba();
    const p = await preparar(api);
    await api.delete(`/api/v1/productos/${p.frijolId}`).expect(200);
    const res = await api.get('/api/v1/inventario/alertas').expect(200);
    expect(res.body.data.minimo).to.deep.equal([]);
    expect(res.body.data.caducidad).to.deep.equal([]);
  });
});
