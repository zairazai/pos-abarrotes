import { expect } from 'chai';
import { fuenteDatos } from '../../src/infraestructura/base-datos/fuente';
import { adelantar, appDePrueba, productoValido, registrosBitacora, type Api } from '../ayuda';

/** Frijol con dos lotes (10 que caducan en marzo y 5 en noviembre) y arroz sin lotes. */
async function preparar(api: Api) {
  const [categoria] = await fuenteDatos.query(`SELECT id FROM categoria WHERE nombre = 'Abarrotes'`);
  const frijol = await api
    .post('/api/v1/productos')
    .send({ ...productoValido, categoriaId: categoria.id })
    .expect(201);
  const arroz = await api
    .post('/api/v1/productos')
    .send({ ...productoValido, codigo: '7501000000099', nombre: 'Arroz 1 kg', categoriaId: categoria.id })
    .expect(201);
  const proveedor = await api.post('/api/v1/proveedores').send({ nombre: 'La Costeña' }).expect(201);
  const entrada = await api
    .post('/api/v1/inventario/entradas')
    .send({
      proveedorId: proveedor.body.data.id,
      folioNota: 'C-1',
      renglones: [
        { productoId: frijol.body.data.id, cantidad: '10', costoUnitario: '30', caducidad: '2027-03-31' },
        { productoId: frijol.body.data.id, cantidad: '5', costoUnitario: '30', caducidad: '2026-11-30' },
      ],
    })
    .expect(201);
  const [marzo, noviembre] = entrada.body.data.renglones.map((r: { loteId: string }) => r.loteId);
  return {
    frijolId: frijol.body.data.id as string,
    arrozId: arroz.body.data.id as string,
    proveedorId: proveedor.body.data.id as string,
    marzo: marzo as string,
    noviembre: noviembre as string,
  };
}

async function existenciaDe(loteId: string): Promise<string> {
  const [{ existencia }] = await fuenteDatos.query(`SELECT existencia FROM lote WHERE id = $1`, [loteId]);
  return existencia;
}

describe('Ajuste por conteo', () => {
  it('si el conteo coincide, no registra nada', async () => {
    const { api } = await appDePrueba();
    const p = await preparar(api);
    const res = await api
      .post('/api/v1/inventario/ajustes')
      .send({ productoId: p.frijolId, contada: '15' })
      .expect(200);
    expect(res.body.message).to.match(/coincide/);
    expect(res.body.data).to.include({ id: null, registrada: '15.00', contada: '15.00', diferencia: '0.00' });
    const [{ n }] = await fuenteDatos.query(`SELECT count(*)::int AS n FROM ajuste`);
    expect(n).to.equal(0);
  });

  it('el faltante sale primero del lote que caduca antes', async () => {
    const { api } = await appDePrueba();
    const p = await preparar(api);
    const res = await api
      .post('/api/v1/inventario/ajustes')
      .send({ productoId: p.frijolId, contada: '8' })
      .expect(201);

    expect(res.body.data).to.include({ registrada: '15.00', contada: '8.00', diferencia: '-7.00' });
    expect(res.body.data.lotes).to.deep.equal([
      { loteId: p.noviembre, cambio: '-5.00', existencia: '0.00' },
      { loteId: p.marzo, cambio: '-2.00', existencia: '8.00' },
    ]);
    const producto = await api.get(`/api/v1/productos/${p.frijolId}`).expect(200);
    expect(producto.body.data.existencia).to.equal('8.00');
  });

  it('el sobrante se suma al lote más reciente; el Empleado también ajusta', async () => {
    const { api, empleado } = await appDePrueba();
    const p = await preparar(api);
    adelantar(1);
    const otra = await api
      .post('/api/v1/inventario/entradas')
      .send({
        proveedorId: p.proveedorId,
        folioNota: 'C-2',
        renglones: [{ productoId: p.frijolId, cantidad: '2', costoUnitario: '30', caducidad: '2027-01-31' }],
      })
      .expect(201);
    const reciente = otra.body.data.renglones[0].loteId;

    const res = await empleado
      .post('/api/v1/inventario/ajustes')
      .send({ productoId: p.frijolId, contada: '20' })
      .expect(201);
    expect(res.body.data.diferencia).to.equal('3.00');
    expect(res.body.data.lotes).to.deep.equal([{ loteId: reciente, cambio: '3.00', existencia: '5.00' }]);
  });

  it('corrige los lotes negativos de una venta sin existencias', async () => {
    const { api } = await appDePrueba();
    const p = await preparar(api);
    await fuenteDatos.query(`UPDATE lote SET existencia = -2 WHERE id = $1`, [p.noviembre]);

    await api.post('/api/v1/inventario/ajustes').send({ productoId: p.frijolId, contada: '6' }).expect(201);
    expect(await existenciaDe(p.noviembre)).to.equal('0.00');
    expect(await existenciaDe(p.marzo)).to.equal('6.00');
  });

  it('si el producto no tiene lotes, lo contado queda en un lote nuevo sin caducidad', async () => {
    const { api } = await appDePrueba();
    const p = await preparar(api);
    const res = await api
      .post('/api/v1/inventario/ajustes')
      .send({ productoId: p.arrozId, contada: '3' })
      .expect(201);
    expect(res.body.data.lotes).to.have.length(1);
    const [lote] = await fuenteDatos.query(`SELECT * FROM lote WHERE producto_id = $1`, [p.arrozId]);
    expect(lote).to.include({
      id: res.body.data.lotes[0].loteId,
      existencia: '3.00',
      origen: 'AJUSTE',
      caducidad: null,
    });
  });

  it('las piezas deben ser enteras y lo contado no puede ser negativo', async () => {
    const { api } = await appDePrueba();
    const p = await preparar(api);
    const res = await api
      .post('/api/v1/inventario/ajustes')
      .send({ productoId: p.frijolId, contada: '2.5' })
      .expect(422);
    expect(res.body.detail).to.match(/enter/);
    await api.post('/api/v1/inventario/ajustes').send({ productoId: p.frijolId, contada: '-1' }).expect(400);
  });

  it('queda en la bitácora con usuario, fecha y diferencia', async () => {
    const { api } = await appDePrueba();
    const p = await preparar(api);
    const res = await api
      .post('/api/v1/inventario/ajustes')
      .send({ productoId: p.frijolId, contada: '14' })
      .expect(201);
    const { registros } = await registrosBitacora({ accion: 'AJUSTE_REGISTRADO' });
    expect(registros).to.have.length(1);
    expect(registros[0]!.entidadId).to.equal(res.body.data.id);
    expect(registros[0]!.antes).to.include({ existencia: '15.00' });
    expect(registros[0]!.despues).to.include({
      productoId: p.frijolId,
      existencia: '14.00',
      diferencia: '-1.00',
    });
  });
});
