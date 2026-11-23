import { expect } from 'chai';
import { randomUUID } from 'node:crypto';
import sinon from 'sinon';
import { fuenteDatos } from '../../src/infraestructura/base-datos/fuente';
import { mensajeria } from '../../src/infraestructura/mensajeria';
import { NotificacionesServicio } from '../../src/modulos/notificaciones/notificaciones';
import { ajustarColas, iniciarEnvios } from '../../src/trabajos/envios';
import { appDePrueba, productoValido, type Api } from '../ayuda';

interface FilaEnvio {
  id: string;
  canal: string;
  tipo: string;
  destinatario: string;
  mensaje: string;
  estado: string;
  intentos: number;
  error: string | null;
}

const envios = (): Promise<FilaEnvio[]> => fuenteDatos.query(`SELECT * FROM envio ORDER BY canal`);

async function producto(api: Api) {
  const [categoria] = await fuenteDatos.query(`SELECT id FROM categoria WHERE nombre = 'Abarrotes'`);
  const res = await api
    .post('/api/v1/productos')
    .send({ ...productoValido, categoriaId: categoria.id })
    .expect(201);
  return res.body.data.id as string;
}

/** Cliente suscrito; con chat, como si se hubiera vinculado con el bot. */
async function cliente(api: Api, datos: object, chat?: string) {
  const res = await api
    .post('/api/v1/clientes')
    .send({ ...datos, aceptaAviso: true })
    .expect(201);
  if (chat) {
    await fuenteDatos.query(`UPDATE cliente SET telegram_chat_id = $1 WHERE id = $2`, [
      chat,
      res.body.data.id,
    ]);
  }
  return res.body.data.id as string;
}

const promocion = (productoId: string) => ({
  productoId,
  tipo: 'PRECIO_ESPECIAL',
  precio: '30.00',
  inicio: '2026-10-20',
  fin: '2026-10-25',
});

describe('Envíos en segundo plano', () => {
  afterEach(() => sinon.restore());

  it('una promoción nueva genera un envío por cliente y canal, solo con consentimiento', async () => {
    const { api } = await appDePrueba();
    const frijol = await producto(api);
    await cliente(api, { correo: 'ana@correo.mx' }, '1001');
    await cliente(api, { telefono: '6671234567' }); // sin correo ni Telegram: no hay canal
    const baja = await cliente(api, { correo: 'beto@correo.mx' });
    await api.post(`/api/v1/clientes/${baja}/baja`).expect(200);

    await api.post('/api/v1/promociones').send(promocion(frijol)).expect(201);

    const filas = await envios();
    expect(filas.map((f) => [f.canal, f.destinatario, f.estado, f.tipo])).to.deep.equal([
      ['CORREO', 'ana@correo.mx', 'PENDIENTE', 'PROMOCION'],
      ['TELEGRAM', '1001', 'PENDIENTE', 'PROMOCION'],
    ]);
    expect(filas[0]!.mensaje).to.include('Frijol negro 1 kg a $30.00');
  });

  it('al enviar queda como ENVIADO con su intento', async () => {
    const { api } = await appDePrueba();
    const frijol = await producto(api);
    await cliente(api, { correo: 'ana@correo.mx' });
    await api.post('/api/v1/promociones').send(promocion(frijol)).expect(201);
    const correo = sinon.stub(mensajeria, 'correo').resolves();

    const [fila] = await envios();
    await new NotificacionesServicio().procesar(fila!.id, 1);
    expect(correo.calledOnce).to.equal(true);
    expect(correo.firstCall.args[0]).to.equal('ana@correo.mx');
    const [enviado] = await envios();
    expect(enviado).to.include({ estado: 'ENVIADO', intentos: 1 });
  });

  it('si falla sigue pendiente para reintentar y al agotar queda FALLIDO con el motivo', async () => {
    const { api } = await appDePrueba();
    const frijol = await producto(api);
    await cliente(api, { correo: 'ana@correo.mx' });
    await api.post('/api/v1/promociones').send(promocion(frijol)).expect(201);
    sinon.stub(mensajeria, 'correo').rejects(new Error('SMTP caído'));
    const servicio = new NotificacionesServicio();

    const [fila] = await envios();
    const error = await servicio.procesar(fila!.id, 1).catch((e: Error) => e);
    expect((error as Error).message).to.equal('SMTP caído');
    expect((await envios())[0]).to.include({ estado: 'PENDIENTE', intentos: 1 });

    await servicio.marcarFallido(fila!.id, 3, 'SMTP caído');
    expect((await envios())[0]).to.include({ estado: 'FALLIDO', intentos: 3, error: 'SMTP caído' });
  });

  it('al darse de baja se cancelan sus envíos pendientes y no salen', async () => {
    const { api } = await appDePrueba();
    const frijol = await producto(api);
    const ana = await cliente(api, { correo: 'ana@correo.mx' });
    await api.post('/api/v1/promociones').send(promocion(frijol)).expect(201);
    await api.post(`/api/v1/clientes/${ana}/baja`).expect(200);
    const correo = sinon.stub(mensajeria, 'correo').resolves();

    const [fila] = await envios();
    expect(fila!.estado).to.equal('CANCELADO');
    await new NotificacionesServicio().procesar(fila!.id, 1);
    expect(correo.called).to.equal(false);
  });

  it('el worker manda lo que está en cola y recupera lo pendiente al arrancar', async () => {
    const { api } = await appDePrueba();
    const frijol = await producto(api);
    await cliente(api, { correo: 'ana@correo.mx' }, '1001');
    await api.post('/api/v1/promociones').send(promocion(frijol)).expect(201);
    // Un pendiente que nunca llegó a la cola, como si Redis hubiera estado caído.
    const [dueno] = await fuenteDatos.query(`SELECT id FROM cliente LIMIT 1`);
    await fuenteDatos.query(
      `INSERT INTO envio (id, canal, tipo, destinatario, cliente_id, asunto, mensaje, estado, intentos, creado_en)
       VALUES ($1, 'CORREO', 'PROMOCION', 'sin-cola@correo.mx', $2, 'Promoción', 'Hola', 'PENDIENTE', 0, now())`,
      [randomUUID(), dueno.id],
    );
    const correo = sinon.stub(mensajeria, 'correo').resolves();
    const telegram = sinon.stub(mensajeria, 'telegram').resolves();

    const { cerrar } = await iniciarEnvios();
    try {
      for (let i = 0; i < 200 && (await envios()).some((f) => f.estado === 'PENDIENTE'); i++) {
        await new Promise((listo) => setTimeout(listo, 25));
      }
      expect((await envios()).map((f) => f.estado)).to.deep.equal(['ENVIADO', 'ENVIADO', 'ENVIADO']);
      expect(correo.callCount).to.equal(2);
      expect(telegram.calledOnce).to.equal(true);
    } finally {
      await cerrar();
    }
  });

  it('sin internet pausa las colas y con internet las reanuda, sin gastar intentos (11.2)', async () => {
    const cola = { pause: sinon.stub().resolves(), resume: sinon.stub().resolves() };
    await ajustarColas([cola], false);
    expect(cola.pause.calledOnce).to.equal(true);
    await ajustarColas([cola], true);
    expect(cola.resume.calledOnce).to.equal(true);
  });

  it('al cerrar la caja el Dueño recibe el resumen y la diferencia por ambos canales', async () => {
    const { api } = await appDePrueba();
    // Como si el Dueño ya hubiera mandado su código al bot.
    await fuenteDatos.query(`UPDATE configuracion_tienda SET telegram_dueno = '900'`);
    await api
      .post('/api/v1/caja/apertura')
      .send({ fondoInicial: { B100: 5 } })
      .expect(201);
    const frijol = await producto(api);
    const [dueno] = await fuenteDatos.query(`SELECT id FROM usuario WHERE rol = 'DUENO'`);
    await api
      .post('/api/v1/ventas')
      .set('Idempotency-Key', randomUUID())
      .send({
        iniciadaPor: dueno.id,
        renglones: [{ productoId: frijol, cantidad: '2' }],
        pagos: [{ metodo: 'EFECTIVO', monto: '100' }],
      })
      .expect(201);
    // Esperado 577.00; dos conteos de 550.00 dejan una diferencia de -27.00.
    await api
      .post('/api/v1/caja/arqueo')
      .send({ conteo: { B500: 1, B50: 1 } })
      .expect(201);
    await api
      .post('/api/v1/caja/arqueo')
      .send({ conteo: { B500: 1, B50: 1 } })
      .expect(201);
    await api.post('/api/v1/caja/cierre').send({ justificacion: 'Cambio mal dado' }).expect(200);

    const filas = await envios();
    expect(filas.map((f) => [f.canal, f.tipo, f.destinatario])).to.deep.equal([
      ['CORREO', 'RESUMEN_DIA', 'dueno@tienda.local'],
      ['TELEGRAM', 'RESUMEN_DIA', '900'],
    ]);
    expect(filas[0]!.mensaje).to.include('1 ventas por $77.00');
    expect(filas[0]!.mensaje).to.include('Ganancia aproximada: $15.00');
    expect(filas[0]!.mensaje).to.include('Diferencia del arqueo: -$27.00 (Cambio mal dado)');
  });

  it('el resumen cuenta lo devuelto aunque sea con saldo a favor', async () => {
    const { api } = await appDePrueba();
    await api
      .post('/api/v1/caja/apertura')
      .send({ fondoInicial: { B100: 5 } })
      .expect(201);
    const frijol = await producto(api);
    const [dueno] = await fuenteDatos.query(`SELECT id FROM usuario WHERE rol = 'DUENO'`);
    await api
      .post('/api/v1/ventas')
      .set('Idempotency-Key', randomUUID())
      .send({
        iniciadaPor: dueno.id,
        renglones: [{ productoId: frijol, cantidad: '2' }],
        pagos: [{ metodo: 'EFECTIVO', monto: '100' }],
      })
      .expect(201);
    // Cambio por producto: no sale efectivo, pero sí se devolvieron $38.50.
    await api
      .post('/api/v1/devoluciones')
      .send({
        folio: 1,
        motivo: 'Lo cambia',
        renglones: [{ renglon: 1, cantidad: '1', destino: 'INVENTARIO' }],
        reembolso: 'SALDO_FAVOR',
      })
      .expect(201);
    await api
      .post('/api/v1/caja/arqueo')
      .send({ conteo: { B500: 1, B50: 1, B20: 1, M5: 1, M2: 1 } })
      .expect(201);
    await api.post('/api/v1/caja/cierre').send({}).expect(200);

    const [correo] = await envios();
    expect(correo!.mensaje).to.include('Devoluciones: $38.50');
  });

  it('si el Dueño no ha vinculado su Telegram, el resumen solo sale por correo', async () => {
    const { api } = await appDePrueba();
    await api
      .post('/api/v1/caja/apertura')
      .send({ fondoInicial: { B100: 5 } })
      .expect(201);
    await api
      .post('/api/v1/caja/arqueo')
      .send({ conteo: { B100: 5 } })
      .expect(201);
    await api.post('/api/v1/caja/cierre').send({}).expect(200);

    const filas = await envios();
    expect(filas.map((f) => [f.canal, f.tipo])).to.deep.equal([['CORREO', 'RESUMEN_DIA']]);
  });

  it('cada promoción dice cómo darse de baja, según el canal', async () => {
    const { api } = await appDePrueba();
    const frijol = await producto(api);
    await cliente(api, { correo: 'ana@correo.mx' }, '1001');
    await api.post('/api/v1/promociones').send(promocion(frijol)).expect(201);

    const [correo, telegram] = await envios();
    expect(correo!.mensaje).to.include('escribe /baja al bot de la tienda o pídelo en la caja');
    expect(telegram!.mensaje).to.match(/Para dejar de recibir promociones escribe \/baja\.$/);
  });

  it('el Dueño consulta los envíos por estado; el Empleado no', async () => {
    const { api, empleado } = await appDePrueba();
    const frijol = await producto(api);
    await cliente(api, { correo: 'ana@correo.mx' });
    await api.post('/api/v1/promociones').send(promocion(frijol)).expect(201);
    await empleado.get('/api/v1/envios').expect(403);

    const res = await api.get('/api/v1/envios?estado=PENDIENTE').expect(200);
    expect(res.body.data).to.have.length(1);
    expect(res.body.data[0]).to.include({ canal: 'CORREO', estado: 'PENDIENTE', tipo: 'PROMOCION' });
    expect(res.body.data[0]).to.not.have.property('destinatario');
    const ninguno = await api.get('/api/v1/envios?estado=FALLIDO').expect(200);
    expect(ninguno.body.data).to.have.length(0);
  });
});
