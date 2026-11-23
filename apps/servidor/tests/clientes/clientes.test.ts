import { expect } from 'chai';
import { fuenteDatos } from '../../src/infraestructura/base-datos/fuente';
import { appDePrueba, registrosBitacora } from '../ayuda';

const ana = { correo: 'ana@correo.mx', telefono: '667 123 4567', aceptaAviso: true };

describe('Clientes', () => {
  it('el Empleado registra un cliente con su consentimiento', async () => {
    const { empleado } = await appDePrueba();
    const res = await empleado.post('/api/v1/clientes').send(ana).expect(201);
    expect(res.body.data).to.include({
      correo: 'ana@correo.mx',
      telefono: '6671234567',
      suscrito: true,
      telegramVinculado: false,
    });
    const [consentimiento] = await fuenteDatos.query(`SELECT origen, revocado_en FROM consentimiento`);
    expect(consentimiento).to.deep.equal({ origen: 'CAJA', revocado_en: null });
  });

  it('si no acepta el aviso no se guarda nada', async () => {
    const { empleado } = await appDePrueba();
    const res = await empleado
      .post('/api/v1/clientes')
      .send({ ...ana, aceptaAviso: false })
      .expect(422);
    expect(res.body.detail).to.match(/aviso de privacidad/);
    const [{ n }] = await fuenteDatos.query(`SELECT count(*)::int AS n FROM cliente`);
    expect(n).to.equal(0);
  });

  it('si ya está suscrito solo lo indica', async () => {
    const { empleado } = await appDePrueba();
    const primero = await empleado.post('/api/v1/clientes').send(ana).expect(201);
    const res = await empleado
      .post('/api/v1/clientes')
      .send({ telefono: '6671234567', aceptaAviso: false })
      .expect(200);
    expect(res.body.message).to.equal('El cliente ya está suscrito');
    expect(res.body.data.id).to.equal(primero.body.data.id);
  });

  it('no mezcla a dos clientes si el correo es de uno y el teléfono de otro', async () => {
    const { empleado } = await appDePrueba();
    await empleado.post('/api/v1/clientes').send({ correo: 'ana@correo.mx', aceptaAviso: true }).expect(201);
    await empleado.post('/api/v1/clientes').send({ telefono: '6671234567', aceptaAviso: true }).expect(201);
    const res = await empleado.post('/api/v1/clientes').send(ana).expect(409);
    expect(res.body.detail).to.match(/clientes distintos/);
  });

  it('busca por correo o por teléfono, sin importar el formato', async () => {
    const { empleado } = await appDePrueba();
    const creado = await empleado.post('/api/v1/clientes').send(ana).expect(201);
    const porCorreo = await empleado.get('/api/v1/clientes?contacto=ANA@correo.mx').expect(200);
    expect(porCorreo.body.data.id).to.equal(creado.body.data.id);
    const porTelefono = await empleado
      .get(`/api/v1/clientes?contacto=${encodeURIComponent('(667) 123-4567')}`)
      .expect(200);
    expect(porTelefono.body.data.id).to.equal(creado.body.data.id);
    await empleado.get('/api/v1/clientes?contacto=nadie@correo.mx').expect(404);
  });

  it('la baja retira el consentimiento y queda en la bitácora, sin los datos', async () => {
    const { empleado } = await appDePrueba();
    const creado = await empleado.post('/api/v1/clientes').send(ana).expect(201);
    const res = await empleado.post(`/api/v1/clientes/${creado.body.data.id}/baja`).expect(200);
    expect(res.body.data.suscrito).to.equal(false);
    const otra = await empleado.post(`/api/v1/clientes/${creado.body.data.id}/baja`).expect(409);
    expect(otra.body.detail).to.match(/ya se dio de baja/);

    const { registros } = await registrosBitacora({ accion: 'CLIENTE_BAJA' });
    expect(registros).to.have.length(1);
    expect(JSON.stringify(registros[0])).to.not.include('ana@correo.mx');
  });

  it('si se dio de baja, debe aceptar otra vez y se conserva su historial de consentimiento', async () => {
    const { empleado } = await appDePrueba();
    const creado = await empleado.post('/api/v1/clientes').send(ana).expect(201);
    await empleado.post(`/api/v1/clientes/${creado.body.data.id}/baja`).expect(200);
    await empleado
      .post('/api/v1/clientes')
      .send({ ...ana, aceptaAviso: false })
      .expect(422);

    const res = await empleado.post('/api/v1/clientes').send(ana).expect(200);
    expect(res.body.message).to.equal('Suscripción renovada');
    expect(res.body.data).to.include({ id: creado.body.data.id, suscrito: true });
    const filas = await fuenteDatos.query(`SELECT revocado_en FROM consentimiento`);
    expect(filas).to.have.length(2);
  });

  it('solo se guardan los datos mínimos: la tabla no tiene nombre ni compras', async () => {
    await appDePrueba();
    const columnas = await fuenteDatos.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'cliente'`,
    );
    expect(columnas.map((c: { column_name: string }) => c.column_name)).to.have.members([
      'id',
      'correo',
      'telefono',
      'telegram_chat_id',
      'creado_en',
    ]);
    const venta = await fuenteDatos.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 'venta' AND column_name = 'cliente_id'`,
    );
    expect(venta).to.have.length(0);
  });
});
