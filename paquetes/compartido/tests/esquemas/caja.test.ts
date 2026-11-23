import { expect } from 'chai';
import {
  esquemaApertura,
  esquemaArqueo,
  esquemaCierre,
  esquemaMovimientoNuevo,
} from '../../src/esquemas/caja';

describe('Esquemas de la caja', () => {
  it('el conteo acepta las denominaciones conocidas con piezas enteras', () => {
    expect(esquemaArqueo.safeParse({ conteo: { B500: 2, M050: 3 } }).success).to.equal(true);
  });

  it('el conteo rechaza denominaciones desconocidas, negativas o con decimales', () => {
    expect(esquemaArqueo.safeParse({ conteo: { M010: 1 } }).success).to.equal(false);
    expect(esquemaArqueo.safeParse({ conteo: { B500: -1 } }).success).to.equal(false);
    expect(esquemaArqueo.safeParse({ conteo: { B500: 1.5 } }).success).to.equal(false);
  });

  it('la apertura solo lleva el fondo por denominación en el primer uso, y es opcional', () => {
    expect(esquemaApertura.safeParse({}).success).to.equal(true);
    expect(esquemaApertura.safeParse({ fondoInicial: { B100: 5 } }).success).to.equal(true);
  });

  it('el movimiento exige tipo, monto positivo y motivo', () => {
    const valido = { tipo: 'RETIRO', monto: '150.00', motivo: 'Pago de garrafón' };
    expect(esquemaMovimientoNuevo.safeParse(valido).success).to.equal(true);
    expect(esquemaMovimientoNuevo.safeParse({ ...valido, monto: '0' }).success).to.equal(false);
    expect(esquemaMovimientoNuevo.safeParse({ ...valido, motivo: ' ' }).success).to.equal(false);
    expect(esquemaMovimientoNuevo.safeParse({ ...valido, tipo: 'PRESTAMO' }).success).to.equal(false);
  });

  it('la justificación del cierre es opcional pero no puede ir vacía', () => {
    expect(esquemaCierre.safeParse({}).success).to.equal(true);
    expect(esquemaCierre.safeParse({ justificacion: '' }).success).to.equal(false);
  });
});
