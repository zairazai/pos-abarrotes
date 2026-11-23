import { expect } from 'chai';
import { fuenteDatos } from '../../src/infraestructura/base-datos/fuente';
import { appDePrueba, productoValido, registrosBitacora, type Api } from '../ayuda';

/**
 * Un producto por pieza con dos lotes: 5 que caducan en noviembre y 10 en marzo. También se registra
 * otro producto, para probar un lote que no le corresponde.
 */
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
      folioNota: 'S-1',
      renglones: [
        { productoId: frijol.body.data.id, cantidad: '10', costoUnitario: '30', caducidad: '2027-03-31' },
        { productoId: frijol.body.data.id, cantidad: '5', costoUnitario: '30', caducidad: '2026-11-30' },
        { productoId: arroz.body.data.id, cantidad: '8', costoUnitario: '20', caducidad: null },
      ],
    })
    .expect(201);
  const [marzo, noviembre, delArroz] = entrada.body.data.renglones.map((r: { loteId: string }) => r.loteId);
  return {
    frijolId: frijol.body.data.id as string,
    arrozId: arroz.body.data.id as string,
    marzo,
    noviembre,
    delArroz,
  };
}

async function existenciaDe(loteId: string): Promise<string> {
  const [{ existencia }] = await fuenteDatos.query(`SELECT existencia FROM lote WHERE id = $1`, [loteId]);
  return existencia;
}

describe('Mermas y consumo propio', () => {
  it('sin lote elegido, descuenta del que caduca primero', async () => {
    const { api } = await appDePrueba();
    const p = await preparar(api);
    const res = await api
      .post('/api/v1/inventario/salidas')
      .send({ tipo: 'MERMA', productoId: p.frijolId, cantidad: '2', motivo: 'Lata abollada' })
      .expect(201);

    expect(res.body.data).to.include({
      tipo: 'MERMA',
      loteId: p.noviembre,
      caducidad: '2026-11-30',
      cantidad: '2',
      existenciaLote: '3.00',
      motivo: 'Lata abollada',
      comentario: null,
    });
    const producto = await api.get(`/api/v1/productos/${p.frijolId}`).expect(200);
    expect(producto.body.data.existencia).to.equal('13.00');
  });

  it('el usuario puede elegir otro lote; el Empleado también registra consumo propio', async () => {
    const { api, empleado } = await appDePrueba();
    const p = await preparar(api);
    const res = await empleado
      .post('/api/v1/inventario/salidas')
      .send({
        tipo: 'CONSUMO',
        productoId: p.frijolId,
        loteId: p.marzo,
        cantidad: '4',
        motivo: 'Comida del personal',
        comentario: 'Lo tomó el Dueño',
      })
      .expect(201);
    expect(res.body.data).to.include({ tipo: 'CONSUMO', loteId: p.marzo, existenciaLote: '6.00' });
    expect(await existenciaDe(p.noviembre)).to.equal('5.00');
  });

  it('la cantidad no puede superar la existencia del lote', async () => {
    const { api } = await appDePrueba();
    const p = await preparar(api);
    const res = await api
      .post('/api/v1/inventario/salidas')
      .send({ tipo: 'MERMA', productoId: p.frijolId, loteId: p.noviembre, cantidad: '6', motivo: 'Caducado' })
      .expect(422);
    expect(res.body.detail).to.match(/supera la existencia del lote \(5\.00\)/);
    expect(await existenciaDe(p.noviembre)).to.equal('5.00');
    const [{ n }] = await fuenteDatos.query(`SELECT count(*)::int AS n FROM salida`);
    expect(n).to.equal(0);
  });

  it('el motivo es obligatorio', async () => {
    const { api } = await appDePrueba();
    const p = await preparar(api);
    const res = await api
      .post('/api/v1/inventario/salidas')
      .send({ tipo: 'MERMA', productoId: p.frijolId, cantidad: '1', motivo: ' ' })
      .expect(400);
    expect(res.body.errores[0].campo).to.equal('body.motivo');
  });

  it('las piezas deben ser enteras', async () => {
    const { api } = await appDePrueba();
    const p = await preparar(api);
    const res = await api
      .post('/api/v1/inventario/salidas')
      .send({ tipo: 'MERMA', productoId: p.frijolId, cantidad: '1.5', motivo: 'Roto' })
      .expect(422);
    expect(res.body.detail).to.match(/enter/);
  });

  it('no acepta un lote de otro producto ni un producto sin existencia', async () => {
    const { api } = await appDePrueba();
    const p = await preparar(api);
    const ajeno = await api
      .post('/api/v1/inventario/salidas')
      .send({ tipo: 'MERMA', productoId: p.frijolId, loteId: p.delArroz, cantidad: '1', motivo: 'Roto' })
      .expect(422);
    expect(ajeno.body.detail).to.match(/lote no es de este producto/);

    await api
      .post('/api/v1/inventario/salidas')
      .send({ tipo: 'MERMA', productoId: p.arrozId, cantidad: '8', motivo: 'Se mojó' })
      .expect(201);
    const sinExistencia = await api
      .post('/api/v1/inventario/salidas')
      .send({ tipo: 'MERMA', productoId: p.arrozId, cantidad: '1', motivo: 'Se mojó' })
      .expect(422);
    expect(sinExistencia.body.detail).to.match(/no tiene existencia/);
  });

  it('queda en la bitácora con el tipo, el lote y el motivo', async () => {
    const { api } = await appDePrueba();
    const p = await preparar(api);
    const res = await api
      .post('/api/v1/inventario/salidas')
      .send({ tipo: 'CONSUMO', productoId: p.frijolId, cantidad: '1', motivo: 'Comida' })
      .expect(201);
    const { registros } = await registrosBitacora({ accion: 'SALIDA_REGISTRADA' });
    expect(registros).to.have.length(1);
    expect(registros[0]!.entidadId).to.equal(res.body.data.id);
    expect(registros[0]!.antes).to.include({ existenciaLote: '5.00' });
    expect(registros[0]!.despues).to.include({
      tipo: 'CONSUMO',
      loteId: p.noviembre,
      cantidad: '1.00',
      motivo: 'Comida',
      existenciaLote: '4.00',
    });
  });
});
