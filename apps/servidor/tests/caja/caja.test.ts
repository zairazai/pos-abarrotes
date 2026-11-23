import { expect } from 'chai';
import sinon from 'sinon';
import { randomUUID } from 'node:crypto';
import { fuenteDatos } from '../../src/infraestructura/base-datos/fuente';
import { BitacoraServicio } from '../../src/modulos/bitacora/bitacora';
import { CajaEntidad, MovimientoEfectivoEntidad } from '../../src/modulos/caja/caja.tablas';
import type { Express } from 'express';
import {
  appDePrueba,
  cliente,
  fijarHora,
  iniciarSesion,
  PIN_DUENO,
  PIN_EMPLEADO,
  registrosBitacora,
  type Api,
} from '../ayuda';

/** 17 de octubre a las 08:00 es la hora de cada prueba; estos son los días siguientes, a la misma hora. */
const MANANA = '2026-10-18T15:00:00.000Z';
const PASADO_MANANA = '2026-10-19T15:00:00.000Z';

/** Fondo del primer uso: 5 billetes de 100 = 500.00. */
const FONDO = { B100: 5 };

async function abrirPrimeraCaja(api: Api) {
  return api.post('/api/v1/caja/apertura').send({ fondoInicial: FONDO }).expect(201);
}

/**
 * Pasa a otro día. El token de acceso dura 15 minutos y el reloj avanzó un día, así que se vuelve a
 * iniciar sesión, como pasa en la tienda.
 */
async function otroDia(app: Express, instante: string) {
  fijarHora(instante);
  return {
    api: cliente(app, await iniciarSesion(app, PIN_DUENO)),
    empleado: cliente(app, await iniciarSesion(app, PIN_EMPLEADO)),
  };
}

async function arquearYCerrar(api: Api, conteo: Record<string, number>) {
  await api.post('/api/v1/caja/arqueo').send({ conteo }).expect(201);
  return api.post('/api/v1/caja/cierre').send({}).expect(200);
}

describe('Caja', () => {
  afterEach(() => sinon.restore());

  describe('apertura', () => {
    it('al instalar pide el fondo del primer uso y no hay caja', async () => {
      const { api } = await appDePrueba();
      const res = await api.get('/api/v1/caja/actual').expect(200);
      expect(res.body.data).to.deep.equal({
        caja: null,
        cajaDeOtroDia: false,
        requiereFondoInicial: true,
        fondoPropuesto: null,
      });
    });

    it('en el primer uso el Dueño abre con el fondo por denominación', async () => {
      const { api } = await appDePrueba();
      const res = await api
        .post('/api/v1/caja/apertura')
        .send({ fondoInicial: { B200: 1, B100: 2, M050: 2 } })
        .expect(201);
      expect(res.body.data).to.include({ fecha: '2026-10-17', estado: 'ABIERTA', fondoInicial: '401.00' });
      expect(res.body.data.esperado).to.equal('401.00');
    });

    it('en el primer uso el Empleado no puede abrir: el Dueño configura el fondo', async () => {
      const { empleado } = await appDePrueba();
      const res = await empleado.post('/api/v1/caja/apertura').send({ fondoInicial: FONDO }).expect(403);
      expect(res.body.detail).to.match(/Dueño debe capturar el fondo inicial/);
    });

    it('en el primer uso no se abre sin el fondo', async () => {
      const { api } = await appDePrueba();
      const res = await api.post('/api/v1/caja/apertura').send({}).expect(422);
      expect(res.body.detail).to.match(/fondo inicial por denominación/);
    });

    it('no se abre una segunda caja si ya hay una abierta', async () => {
      const { api } = await appDePrueba();
      await abrirPrimeraCaja(api);
      const res = await api.post('/api/v1/caja/apertura').send({}).expect(409);
      expect(res.body.detail).to.match(/ya está abierta/);
    });

    it('solo hay una caja por día: cerrada hoy, no se vuelve a abrir', async () => {
      const { api } = await appDePrueba();
      await abrirPrimeraCaja(api);
      await arquearYCerrar(api, FONDO);
      const res = await api.post('/api/v1/caja/apertura').send({}).expect(409);
      expect(res.body.detail).to.match(/ya se cerró/);
    });

    it('al día siguiente propone y usa como fondo el efectivo del cierre anterior', async () => {
      const { app, api } = await appDePrueba();
      await abrirPrimeraCaja(api);
      await api
        .post('/api/v1/caja/movimientos')
        .send({ tipo: 'INGRESO', monto: '120.00', motivo: 'Cambio traído del banco' })
        .expect(201);
      await arquearYCerrar(api, { B500: 1, B100: 1, B20: 1 });

      const manana = await otroDia(app, MANANA);
      const actual = await manana.api.get('/api/v1/caja/actual').expect(200);
      expect(actual.body.data).to.include({ requiereFondoInicial: false, fondoPropuesto: '620.00' });
      expect(actual.body.data.caja).to.equal(null);

      const res = await manana.api.post('/api/v1/caja/apertura').send({}).expect(201);
      expect(res.body.data).to.include({ fecha: '2026-10-18', fondoInicial: '620.00' });
    });

    it('después del primer uso, el Empleado abre con el fondo del cierre anterior', async () => {
      const { app, api } = await appDePrueba();
      await abrirPrimeraCaja(api);
      await arquearYCerrar(api, FONDO);
      const { empleado } = await otroDia(app, MANANA);
      const res = await empleado.post('/api/v1/caja/apertura').send({}).expect(201);
      expect(res.body.data.fondoInicial).to.equal('500.00');
    });

    it('después del primer uso no acepta otro fondo por denominación', async () => {
      const { app, api } = await appDePrueba();
      await abrirPrimeraCaja(api);
      await arquearYCerrar(api, FONDO);
      const manana = await otroDia(app, MANANA);
      await manana.api
        .post('/api/v1/caja/apertura')
        .send({ fondoInicial: { B1000: 1 } })
        .expect(422);
    });

    it('la apertura queda en la bitácora', async () => {
      const { api } = await appDePrueba();
      await abrirPrimeraCaja(api);
      const { registros } = await registrosBitacora({ accion: 'CAJA_ABIERTA' });
      expect(registros).to.have.length(1);
      expect(registros[0]!.despues).to.include({ fondoInicial: '500.00', primerUso: true });
    });
  });

  describe('caja olvidada de otro día', () => {
    it('no deja abrir la de hoy hasta cerrar la anterior, que sí se puede cerrar', async () => {
      const { app, api: hoy } = await appDePrueba();
      await abrirPrimeraCaja(hoy);

      const { api } = await otroDia(app, MANANA);
      const actual = await api.get('/api/v1/caja/actual').expect(200);
      expect(actual.body.data.cajaDeOtroDia).to.equal(true);
      expect(actual.body.data.caja.fecha).to.equal('2026-10-17');

      const apertura = await api.post('/api/v1/caja/apertura').send({}).expect(409);
      expect(apertura.body.detail).to.match(/caja del 2026-10-17 sigue abierta/);

      await arquearYCerrar(api, FONDO);
      const res = await api.post('/api/v1/caja/apertura').send({}).expect(201);
      expect(res.body.data).to.include({ fecha: '2026-10-18', fondoInicial: '500.00' });
    });

    it('no acepta movimientos en la caja de otro día', async () => {
      const { app, api: hoy } = await appDePrueba();
      await abrirPrimeraCaja(hoy);
      const { api } = await otroDia(app, MANANA);
      const res = await api
        .post('/api/v1/caja/movimientos')
        .send({ tipo: 'RETIRO', monto: '10', motivo: 'Garrafón' })
        .expect(409);
      expect(res.body.detail).to.match(/ciérrela, y abra la de hoy/);
    });
  });

  describe('retiros e ingresos', () => {
    it('registra un retiro y un ingreso con usuario y fecha, y cambian el esperado', async () => {
      const { api } = await appDePrueba();
      await abrirPrimeraCaja(api);
      const retiro = await api
        .post('/api/v1/caja/movimientos')
        .send({ tipo: 'RETIRO', monto: '150.00', motivo: 'Pago del garrafón' })
        .expect(201);
      expect(retiro.body.data).to.include({ tipo: 'RETIRO', monto: '150.00', motivo: 'Pago del garrafón' });
      expect(retiro.body.data.fecha).to.equal('2026-10-17T15:00:00.000Z');
      await api
        .post('/api/v1/caja/movimientos')
        .send({ tipo: 'INGRESO', monto: '50.50', motivo: 'Cambio' })
        .expect(201);

      const actual = await api.get('/api/v1/caja/actual').expect(200);
      expect(actual.body.data.caja.movimientos).to.have.length(2);
      expect(actual.body.data.caja.esperado).to.equal('400.50');
    });

    it('el Empleado registra movimientos pero no ve el efectivo esperado', async () => {
      const { api, empleado } = await appDePrueba();
      await abrirPrimeraCaja(api);
      await empleado
        .post('/api/v1/caja/movimientos')
        .send({ tipo: 'RETIRO', monto: '20', motivo: 'Hielo' })
        .expect(201);
      const actual = await empleado.get('/api/v1/caja/actual').expect(200);
      expect(actual.body.data.caja).to.not.have.property('esperado');
      expect(actual.body.data.caja.movimientos).to.have.length(1);
    });

    it('un retiro mayor que el efectivo no se bloquea; la diferencia sale en el arqueo', async () => {
      const { api } = await appDePrueba();
      await abrirPrimeraCaja(api);
      await api
        .post('/api/v1/caja/movimientos')
        .send({ tipo: 'RETIRO', monto: '900', motivo: 'Pago de luz' })
        .expect(201);
    });

    it('sin caja abierta no se registran movimientos', async () => {
      const { api } = await appDePrueba();
      const res = await api
        .post('/api/v1/caja/movimientos')
        .send({ tipo: 'RETIRO', monto: '10', motivo: 'Hielo' })
        .expect(422);
      expect(res.body.detail).to.match(/No hay una caja abierta/);
    });

    it('rechaza monto cero y motivo vacío indicando el campo', async () => {
      const { api } = await appDePrueba();
      await abrirPrimeraCaja(api);
      const res = await api
        .post('/api/v1/caja/movimientos')
        .send({ tipo: 'RETIRO', monto: '0', motivo: '' })
        .expect(400);
      expect(res.body.errores.map((e: { campo: string }) => e.campo)).to.have.members([
        'body.monto',
        'body.motivo',
      ]);
    });

    it('cada movimiento queda en la bitácora', async () => {
      const { api } = await appDePrueba();
      await abrirPrimeraCaja(api);
      await api.post('/api/v1/caja/movimientos').send({ tipo: 'RETIRO', monto: '10', motivo: 'Hielo' });
      await api.post('/api/v1/caja/movimientos').send({ tipo: 'INGRESO', monto: '5', motivo: 'Cambio' });
      expect((await registrosBitacora({ accion: 'CAJA_RETIRO' })).registros).to.have.length(1);
      expect((await registrosBitacora({ accion: 'CAJA_INGRESO' })).registros).to.have.length(1);
    });

    it('después de empezar el arqueo ya no se registran movimientos', async () => {
      const { api } = await appDePrueba();
      await abrirPrimeraCaja(api);
      await api
        .post('/api/v1/caja/arqueo')
        .send({ conteo: { B100: 4 } })
        .expect(201);
      const res = await api
        .post('/api/v1/caja/movimientos')
        .send({ tipo: 'INGRESO', monto: '100', motivo: 'Lo que faltaba' })
        .expect(409);
      expect(res.body.detail).to.match(/arqueo/);
    });
  });

  describe('arqueo y cierre', () => {
    it('si el conteo cuadra, cierra y el efectivo contado queda como fondo de mañana', async () => {
      const { api } = await appDePrueba();
      await abrirPrimeraCaja(api);
      const arqueo = await api
        .post('/api/v1/caja/arqueo')
        .send({ conteo: { B500: 1 } })
        .expect(201);
      expect(arqueo.body.data).to.deep.equal({
        intento: 1,
        resultado: 'CUADRA',
        contado: '500.00',
        esperado: '500.00',
        diferencia: '0.00',
      });
      const cierre = await api.post('/api/v1/caja/cierre').send({}).expect(200);
      expect(cierre.body.data).to.include({
        estado: 'CERRADA',
        efectivoFinal: '500.00',
        diferencia: '0.00',
        justificacion: null,
      });
    });

    it('con diferencia pide un reconteo; si persiste, exige justificación y cierra con ella', async () => {
      const { api } = await appDePrueba();
      await abrirPrimeraCaja(api);

      const primero = await api
        .post('/api/v1/caja/arqueo')
        .send({ conteo: { B100: 4 } })
        .expect(201);
      expect(primero.body.data).to.include({ intento: 1, resultado: 'RECONTAR', diferencia: '-100.00' });
      expect(primero.body.message).to.match(/recuente/);
      await api.post('/api/v1/caja/cierre').send({}).expect(422);

      const reconteo = await api
        .post('/api/v1/caja/arqueo')
        .send({ conteo: { B100: 4, B50: 1 } })
        .expect(201);
      expect(reconteo.body.data).to.include({ intento: 2, resultado: 'JUSTIFICAR', diferencia: '-50.00' });

      const sinJustificar = await api.post('/api/v1/caja/cierre').send({}).expect(422);
      expect(sinJustificar.body.detail).to.match(/justificación/);
      const cierre = await api
        .post('/api/v1/caja/cierre')
        .send({ justificacion: 'Se pagó al repartidor del pan sin registrar el retiro' })
        .expect(200);
      expect(cierre.body.data).to.include({ efectivoFinal: '450.00', diferencia: '-50.00' });
      expect(cierre.body.data.justificacion).to.match(/repartidor/);
    });

    it('si el reconteo cuadra, cierra sin justificación', async () => {
      const { api } = await appDePrueba();
      await abrirPrimeraCaja(api);
      await api
        .post('/api/v1/caja/arqueo')
        .send({ conteo: { B100: 4 } })
        .expect(201);
      const reconteo = await api.post('/api/v1/caja/arqueo').send({ conteo: FONDO }).expect(201);
      expect(reconteo.body.data.resultado).to.equal('CUADRA');
      await api.post('/api/v1/caja/cierre').send({}).expect(200);
    });

    it('solo hay un reconteo', async () => {
      const { api } = await appDePrueba();
      await abrirPrimeraCaja(api);
      await api
        .post('/api/v1/caja/arqueo')
        .send({ conteo: { B100: 1 } })
        .expect(201);
      await api
        .post('/api/v1/caja/arqueo')
        .send({ conteo: { B100: 2 } })
        .expect(201);
      const res = await api
        .post('/api/v1/caja/arqueo')
        .send({ conteo: { B100: 5 } })
        .expect(409);
      expect(res.body.detail).to.match(/Ya se hizo el reconteo/);
    });

    it('el Empleado solo sabe si cuadra, sin montos esperados ni diferencia (arqueo ciego)', async () => {
      const { api, empleado } = await appDePrueba();
      await abrirPrimeraCaja(api);
      const arqueo = await empleado
        .post('/api/v1/caja/arqueo')
        .send({ conteo: { B100: 4 } })
        .expect(201);
      expect(arqueo.body.data).to.deep.equal({ intento: 1, resultado: 'RECONTAR', contado: '400.00' });
      expect(JSON.stringify(arqueo.body)).to.not.match(/esperado|diferencia|-100/);

      await empleado
        .post('/api/v1/caja/arqueo')
        .send({ conteo: { B100: 4 } })
        .expect(201);
      const cierre = await empleado
        .post('/api/v1/caja/cierre')
        .send({ justificacion: 'No se encontró el faltante' })
        .expect(200);
      expect(cierre.body.data).to.not.have.property('esperado');
      expect(cierre.body.data).to.not.have.property('diferencia');
      expect(cierre.body.data.ultimoArqueo).to.not.have.property('esperado');
    });

    it('no se cierra sin contar el efectivo', async () => {
      const { api } = await appDePrueba();
      await abrirPrimeraCaja(api);
      const res = await api.post('/api/v1/caja/cierre').send({}).expect(422);
      expect(res.body.detail).to.match(/arqueo/);
    });

    it('no se cuenta ni se cierra sin caja abierta', async () => {
      const { api } = await appDePrueba();
      await api.post('/api/v1/caja/arqueo').send({ conteo: FONDO }).expect(422);
      await api.post('/api/v1/caja/cierre').send({}).expect(422);
    });

    it('guarda el conteo por denominación', async () => {
      const { api } = await appDePrueba();
      await abrirPrimeraCaja(api);
      await api
        .post('/api/v1/caja/arqueo')
        .send({ conteo: { B200: 2, M050: 2, M1: 0 } })
        .expect(201);
      const filas = await fuenteDatos.query(
        'SELECT clave, valor, cantidad FROM arqueo_denominacion ORDER BY valor DESC',
      );
      expect(filas).to.deep.equal([
        { clave: 'B200', valor: '200.00', cantidad: 2 },
        { clave: 'M050', valor: '0.50', cantidad: 2 },
      ]);
    });

    it('el arqueo y el cierre quedan en la bitácora', async () => {
      const { api } = await appDePrueba();
      await abrirPrimeraCaja(api);
      await arquearYCerrar(api, FONDO);
      expect((await registrosBitacora({ accion: 'CAJA_ARQUEO' })).registros).to.have.length(1);
      const { registros } = await registrosBitacora({ accion: 'CAJA_CERRADA' });
      expect(registros[0]!.despues).to.include({ efectivoFinal: '500.00', diferencia: '0.00' });
    });

    it('tres días seguidos: cada fondo es el efectivo del cierre anterior', async () => {
      const { app, api } = await appDePrueba();
      await abrirPrimeraCaja(api);
      await arquearYCerrar(api, FONDO);

      const manana = (await otroDia(app, MANANA)).api;
      await manana.post('/api/v1/caja/apertura').send({}).expect(201);
      await manana
        .post('/api/v1/caja/movimientos')
        .send({ tipo: 'RETIRO', monto: '300', motivo: 'Depósito' })
        .expect(201);
      await arquearYCerrar(manana, { B200: 1 });

      const pasado = (await otroDia(app, PASADO_MANANA)).api;
      const res = await pasado.post('/api/v1/caja/apertura').send({}).expect(201);
      expect(res.body.data.fondoInicial).to.equal('200.00');
    });
  });

  describe('operaciones completas o nada', () => {
    it('si falla la bitácora al registrar un retiro, el retiro no queda', async () => {
      const { api } = await appDePrueba();
      await abrirPrimeraCaja(api);
      sinon.stub(BitacoraServicio.prototype, 'registrar').rejects(new Error('falla simulada'));
      await api
        .post('/api/v1/caja/movimientos')
        .send({ tipo: 'RETIRO', monto: '10', motivo: 'Hielo' })
        .expect(500);
      sinon.restore();
      expect(await fuenteDatos.getRepository(MovimientoEfectivoEntidad).count()).to.equal(0);
    });

    it('si falla a mitad del cierre, la caja sigue abierta y sin fondo para mañana', async () => {
      const { api } = await appDePrueba();
      await abrirPrimeraCaja(api);
      await api.post('/api/v1/caja/arqueo').send({ conteo: FONDO }).expect(201);
      sinon.stub(BitacoraServicio.prototype, 'registrar').rejects(new Error('falla simulada'));
      await api.post('/api/v1/caja/cierre').send({}).expect(500);
      sinon.restore();
      const caja = await fuenteDatos.getRepository(CajaEntidad).findOneByOrFail({ fecha: '2026-10-17' });
      expect(caja.estado).to.equal('ABIERTA');
      expect(caja.efectivoFinal).to.equal(null);
    });

    it('si falla la bitácora al abrir, no queda ninguna caja', async () => {
      const { api } = await appDePrueba();
      sinon.stub(BitacoraServicio.prototype, 'registrar').rejects(new Error('falla simulada'));
      await api.post('/api/v1/caja/apertura').send({ fondoInicial: FONDO }).expect(500);
      sinon.restore();
      expect(await fuenteDatos.getRepository(CajaEntidad).count()).to.equal(0);
    });
  });

  describe('reglas que defiende PostgreSQL', () => {
    it('no permite dos cajas abiertas aunque sean de días distintos', async () => {
      const { api } = await appDePrueba();
      await abrirPrimeraCaja(api);
      const [usuario] = await fuenteDatos.query(`SELECT id FROM usuario WHERE rol = 'DUENO'`);
      const error = await fuenteDatos
        .query(
          `INSERT INTO caja (id, fecha, estado, fondo_inicial, abierta_por, abierta_en)
           VALUES ($1, '2026-10-18', 'ABIERTA', 0, $2, now())`,
          [randomUUID(), usuario.id],
        )
        .catch((e: Error) => e);
      expect(error).to.be.instanceOf(Error);
      expect((error as Error).message).to.match(/caja_una_abierta/);
    });

    it('no permite cerrar con diferencia sin justificación', async () => {
      const { api } = await appDePrueba();
      await abrirPrimeraCaja(api);
      const [usuario] = await fuenteDatos.query(`SELECT id FROM usuario WHERE rol = 'DUENO'`);
      const error = await fuenteDatos
        .query(
          `UPDATE caja SET estado = 'CERRADA', cerrada_por = $1, cerrada_en = now(),
             efectivo_final = 400, diferencia = -100`,
          [usuario.id],
        )
        .catch((e: Error) => e);
      expect(error).to.be.instanceOf(Error);
    });
  });
});
