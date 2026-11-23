import { expect } from 'chai';
import { fuenteDatos } from '../../src/infraestructura/base-datos/fuente';
import { appDePrueba, productoValido, registrosBitacora, type Api } from '../ayuda';

/** Datos de una entrada lista para enviar: un proveedor y dos productos (uno por pieza y uno a granel). */
async function preparar(api: Api) {
  const [categoria] = await fuenteDatos.query(`SELECT id FROM categoria WHERE nombre = 'Abarrotes'`);
  const frijol = await api
    .post('/api/v1/productos')
    .send({ ...productoValido, categoriaId: categoria.id })
    .expect(201);
  const azucar = await api
    .post('/api/v1/productos')
    .send({
      ...productoValido,
      codigo: 'GR-AZUCAR',
      nombre: 'Azúcar a granel',
      unidad: 'KG',
      categoriaId: categoria.id,
    })
    .expect(201);
  const proveedor = await api
    .post('/api/v1/proveedores')
    .send({ nombre: 'Abarrotera del Valle' })
    .expect(201);
  return {
    frijolId: frijol.body.data.id as string,
    azucarId: azucar.body.data.id as string,
    proveedorId: proveedor.body.data.id as string,
  };
}

function entrada(p: { frijolId: string; azucarId: string; proveedorId: string }) {
  return {
    proveedorId: p.proveedorId,
    folioNota: 'A-1234',
    renglones: [
      { productoId: p.frijolId, cantidad: '12', costoUnitario: '32.50', caducidad: '2027-03-31' },
      { productoId: p.azucarId, cantidad: '10.5', costoUnitario: '22.00', caducidad: null },
    ],
  };
}

describe('Entradas de mercancía', () => {
  it('registra la entrada con su total y un lote por producto', async () => {
    const { api } = await appDePrueba();
    const p = await preparar(api);
    const res = await api.post('/api/v1/inventario/entradas').send(entrada(p)).expect(201);

    expect(res.body.data).to.include({ folioNota: 'A-1234', total: '621.00' });
    expect(res.body.data.proveedor.nombre).to.equal('Abarrotera del Valle');
    expect(res.body.data.renglones.map((r: { importe: string }) => r.importe)).to.deep.equal([
      '390.00',
      '231.00',
    ]);

    const lotes = await fuenteDatos.query(
      `SELECT producto_id, caducidad, existencia, origen FROM lote ORDER BY existencia DESC`,
    );
    expect(lotes).to.have.length(2);
    expect(lotes[0]).to.include({ producto_id: p.frijolId, existencia: '12.00', origen: 'ENTRADA' });
    expect(lotes[1]).to.include({ producto_id: p.azucarId, existencia: '10.50', caducidad: null });
  });

  it('la existencia del catálogo sube con la entrada', async () => {
    const { api } = await appDePrueba();
    const p = await preparar(api);
    await api.post('/api/v1/inventario/entradas').send(entrada(p)).expect(201);
    const res = await api.get(`/api/v1/productos?buscar=frijol`).expect(200);
    expect(res.body.data[0].existencia).to.equal('12.00');
  });

  it('el costo del producto cambia al de la última entrada', async () => {
    const { api } = await appDePrueba();
    const p = await preparar(api);
    await api.post('/api/v1/inventario/entradas').send(entrada(p)).expect(201);
    const producto = await api.get(`/api/v1/productos/${p.frijolId}`).expect(200);
    expect(producto.body.data.costo).to.equal('32.50');
  });

  it('el Empleado también registra entradas', async () => {
    const { api, empleado } = await appDePrueba();
    const p = await preparar(api);
    await empleado.post('/api/v1/inventario/entradas').send(entrada(p)).expect(201);
  });

  it('la caducidad es obligatoria: fecha o null para "No aplica"', async () => {
    const { api } = await appDePrueba();
    const p = await preparar(api);
    const datos = entrada(p);
    const { caducidad: _, ...sinCaducidad } = datos.renglones[0]!;
    const res = await api
      .post('/api/v1/inventario/entradas')
      .send({ ...datos, renglones: [sinCaducidad] })
      .expect(400);
    expect(res.body.errores[0]).to.include({
      campo: 'body.renglones.0.caducidad',
      mensaje: 'Es obligatorio',
    });
  });

  it('los productos por pieza solo aceptan cantidades enteras', async () => {
    const { api } = await appDePrueba();
    const p = await preparar(api);
    const datos = entrada(p);
    datos.renglones[0]!.cantidad = '2.5';
    const res = await api.post('/api/v1/inventario/entradas').send(datos).expect(422);
    expect(res.body.detail).to.match(/enter/);
  });

  it('no acepta un proveedor que no está registrado', async () => {
    const { api } = await appDePrueba();
    const p = await preparar(api);
    const res = await api
      .post('/api/v1/inventario/entradas')
      .send({ ...entrada(p), proveedorId: '3f1c2b8e-8a4d-4c55-9a77-6c1d2f0e9b10' })
      .expect(422);
    expect(res.body.detail).to.match(/proveedor no está registrado/);
  });

  it('no acepta productos desactivados', async () => {
    const { api } = await appDePrueba();
    const p = await preparar(api);
    await api.delete(`/api/v1/productos/${p.frijolId}`).expect(200);
    const res = await api.post('/api/v1/inventario/entradas').send(entrada(p)).expect(422);
    expect(res.body.detail).to.match(/desactivado/);
  });

  it('la misma nota del mismo proveedor no se registra dos veces', async () => {
    const { api } = await appDePrueba();
    const p = await preparar(api);
    await api.post('/api/v1/inventario/entradas').send(entrada(p)).expect(201);
    const res = await api
      .post('/api/v1/inventario/entradas')
      .send({ ...entrada(p), folioNota: 'a-1234' })
      .expect(409);
    expect(res.body.detail).to.match(/ya se registró/);
    const [{ n }] = await fuenteDatos.query(`SELECT count(*)::int AS n FROM lote`);
    expect(n).to.equal(2);
  });

  it('si falla a mitad de la transacción no queda nada guardado', async () => {
    const { api } = await appDePrueba();
    const p = await preparar(api);
    // Una restricción temporal (importe < 300) hace fallar el último INSERT de la transacción.
    await fuenteDatos.query(`ALTER TABLE entrada_detalle ADD CONSTRAINT prueba_falla CHECK (importe < 300)`);
    try {
      await api.post('/api/v1/inventario/entradas').send(entrada(p)).expect(500);
    } finally {
      await fuenteDatos.query(`ALTER TABLE entrada_detalle DROP CONSTRAINT prueba_falla`);
    }
    const [{ entradas }] = await fuenteDatos.query(`SELECT count(*)::int AS entradas FROM entrada`);
    const [{ lotes }] = await fuenteDatos.query(`SELECT count(*)::int AS lotes FROM lote`);
    const [{ costo }] = await fuenteDatos.query(`SELECT costo FROM producto WHERE id = $1`, [p.frijolId]);
    expect({ entradas, lotes, costo }).to.deep.equal({ entradas: 0, lotes: 0, costo: '31.00' });
  });

  it('queda en la bitácora con el costo anterior y el nuevo', async () => {
    const { api } = await appDePrueba();
    const p = await preparar(api);
    const res = await api.post('/api/v1/inventario/entradas').send(entrada(p)).expect(201);
    const { registros } = await registrosBitacora({ accion: 'ENTRADA_REGISTRADA' });
    expect(registros).to.have.length(1);
    expect(registros[0]!.entidadId).to.equal(res.body.data.id);
    expect(registros[0]!.despues).to.include({ folioNota: 'A-1234', total: '621.00', renglones: 2 });
  });

  it('se consultan la lista y una entrada por su id', async () => {
    const { api } = await appDePrueba();
    const p = await preparar(api);
    const creada = await api.post('/api/v1/inventario/entradas').send(entrada(p)).expect(201);
    const lista = await api.get('/api/v1/inventario/entradas').expect(200);
    expect(lista.body.meta.totalRecords).to.equal(1);
    const una = await api.get(`/api/v1/inventario/entradas/${creada.body.data.id}`).expect(200);
    expect(una.body.data).to.deep.equal(creada.body.data);
    await api.get('/api/v1/inventario/entradas/3f1c2b8e-8a4d-4c55-9a77-6c1d2f0e9b10').expect(404);
  });
});

describe('Pago a proveedor', () => {
  // La nota de entrada() suma 621.00; con 7 billetes de 100 sí alcanza.
  async function abrirCaja(api: Api, billetes = 7) {
    await api
      .post('/api/v1/caja/apertura')
      .send({ fondoInicial: { B100: billetes } })
      .expect(201);
  }

  it('con la caja abierta, la entrada se paga al registrarla y el pago sale del esperado', async () => {
    const { api } = await appDePrueba();
    const p = await preparar(api);
    await abrirCaja(api);
    const res = await api
      .post('/api/v1/inventario/entradas')
      .send({ ...entrada(p), pago: { monto: '621.00' } })
      .expect(201);

    expect(res.body.message).to.equal('Entrada registrada y pagada');
    expect(res.body.data.pago).to.include({
      monto: '621.00',
      motivo: 'Pago de la nota A-1234 de Abarrotera del Valle',
    });

    const caja = await api.get('/api/v1/caja/actual').expect(200);
    expect(caja.body.data.caja.esperado).to.equal('79.00');
    expect(caja.body.data.caja.movimientos[0]).to.include({
      tipo: 'PAGO_PROVEEDOR',
      monto: '621.00',
      entradaId: res.body.data.id,
    });
  });

  it('sin caja abierta, la entrada se guarda sin pago y la respuesta lo avisa', async () => {
    const { api } = await appDePrueba();
    const p = await preparar(api);
    const res = await api
      .post('/api/v1/inventario/entradas')
      .send({ ...entrada(p), pago: { monto: '621.00' } })
      .expect(201);
    expect(res.body.message).to.match(/sin pago.*No hay una caja abierta/);
    expect(res.body.data.pago).to.equal(null);
    const [{ n }] = await fuenteDatos.query(`SELECT count(*)::int AS n FROM movimiento_efectivo`);
    expect(n).to.equal(0);
  });

  it('el pago se registra después, con su propio motivo, y queda en la entrada', async () => {
    const { api, empleado } = await appDePrueba();
    const p = await preparar(api);
    const creada = await api.post('/api/v1/inventario/entradas').send(entrada(p)).expect(201);
    expect(creada.body.data.pago).to.equal(null);
    await abrirCaja(api);

    const res = await empleado
      .post(`/api/v1/inventario/entradas/${creada.body.data.id}/pago`)
      .send({ monto: '621.00', motivo: 'Pago de contado' })
      .expect(201);
    expect(res.body.data.pago).to.include({ monto: '621.00', motivo: 'Pago de contado' });

    const una = await api.get(`/api/v1/inventario/entradas/${creada.body.data.id}`).expect(200);
    expect(una.body.data.pago.monto).to.equal('621.00');
  });

  it('una entrada solo se paga una vez', async () => {
    const { api } = await appDePrueba();
    const p = await preparar(api);
    await abrirCaja(api);
    const creada = await api
      .post('/api/v1/inventario/entradas')
      .send({ ...entrada(p), pago: { monto: '621.00' } })
      .expect(201);
    const res = await api
      .post(`/api/v1/inventario/entradas/${creada.body.data.id}/pago`)
      .send({ monto: '10.00' })
      .expect(409);
    expect(res.body.detail).to.match(/ya se pagó/);
  });

  it('el pago posterior necesita la caja abierta, una entrada que exista y un monto positivo', async () => {
    const { api } = await appDePrueba();
    const p = await preparar(api);
    const creada = await api.post('/api/v1/inventario/entradas').send(entrada(p)).expect(201);
    const url = `/api/v1/inventario/entradas/${creada.body.data.id}/pago`;

    const sinCaja = await api.post(url).send({ monto: '621.00' }).expect(422);
    expect(sinCaja.body.detail).to.match(/No hay una caja abierta/);

    await abrirCaja(api);
    await api.post(url).send({ monto: '0' }).expect(400);
    await api
      .post('/api/v1/inventario/entradas/3f1c2b8e-8a4d-4c55-9a77-6c1d2f0e9b10/pago')
      .send({ monto: '100.00' })
      .expect(404);
  });

  it('el pago es todo o nada: si no es el total de la nota, no se registra nada', async () => {
    const { api } = await appDePrueba();
    const p = await preparar(api);
    await abrirCaja(api);
    const res = await api
      .post('/api/v1/inventario/entradas')
      .send({ ...entrada(p), pago: { monto: '300.00' } })
      .expect(422);
    expect(res.body.detail).to.equal('El pago debe ser el total de la nota ($621.00)');
    const [{ n }] = await fuenteDatos.query(`SELECT count(*)::int AS n FROM entrada`);
    expect(n).to.equal(0);

    const creada = await api.post('/api/v1/inventario/entradas').send(entrada(p)).expect(201);
    await api
      .post(`/api/v1/inventario/entradas/${creada.body.data.id}/pago`)
      .send({ monto: '700.00' })
      .expect(422);
  });

  it('si el efectivo no alcanza, la entrada se guarda sin pago y se paga cuando haya', async () => {
    const { api } = await appDePrueba();
    const p = await preparar(api);
    await abrirCaja(api, 5);
    const creada = await api
      .post('/api/v1/inventario/entradas')
      .send({ ...entrada(p), pago: { monto: '621.00' } })
      .expect(201);
    expect(creada.body.message).to.include('sin pago: En caja hay $500.00; no alcanza para pagar $621.00');
    expect(creada.body.data.pago).to.equal(null);

    const url = `/api/v1/inventario/entradas/${creada.body.data.id}/pago`;
    const falta = await api.post(url).send({ monto: '621.00' }).expect(422);
    expect(falta.body.detail).to.match(/no alcanza/);

    await api
      .post('/api/v1/caja/movimientos')
      .send({ tipo: 'INGRESO', monto: '121.00', motivo: 'Dinero para el proveedor' })
      .expect(201);
    await api.post(url).send({ monto: '621.00' }).expect(201);
    const caja = await api.get('/api/v1/caja/actual').expect(200);
    expect(caja.body.data.caja.esperado).to.equal('0.00');
  });

  it('queda en la bitácora vinculado a la entrada', async () => {
    const { api } = await appDePrueba();
    const p = await preparar(api);
    await abrirCaja(api);
    const creada = await api
      .post('/api/v1/inventario/entradas')
      .send({ ...entrada(p), pago: { monto: '621.00' } })
      .expect(201);
    const { registros } = await registrosBitacora({ accion: 'PAGO_PROVEEDOR' });
    expect(registros).to.have.length(1);
    expect(registros[0]!.despues).to.include({ entradaId: creada.body.data.id, monto: '621.00' });
    const entradas = await registrosBitacora({ accion: 'ENTRADA_REGISTRADA' });
    expect(entradas.registros[0]!.despues).to.include({ pago: '621.00', sinPago: null });
  });

  it('la bitácora de la entrada dice si quedó sin pago y por qué', async () => {
    const { api } = await appDePrueba();
    const p = await preparar(api);
    await abrirCaja(api, 5);
    await api
      .post('/api/v1/inventario/entradas')
      .send({ ...entrada(p), pago: { monto: '621.00' } })
      .expect(201);
    await api
      .post('/api/v1/inventario/entradas')
      .send({ ...entrada(p), folioNota: 'A-1235' })
      .expect(201);

    const { registros } = await registrosBitacora({ accion: 'ENTRADA_REGISTRADA' });
    const porFolio = new Map(
      registros.map((r) => [(r.despues as { folioNota: string }).folioNota, r.despues]),
    );
    expect(porFolio.get('A-1234')).to.include({
      pago: null,
      sinPago: 'En caja hay $500.00; no alcanza para pagar $621.00',
    });
    // Sin pago en la petición no hay motivo que anotar.
    expect(porFolio.get('A-1235')).to.include({ pago: null, sinPago: null });
  });
});
