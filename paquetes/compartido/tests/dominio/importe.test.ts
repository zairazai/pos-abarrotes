import { expect } from 'chai';
import { dinero, peso, importePorPieza, importePorPeso } from '../../src/dominio/importe';

describe('Importes', () => {
  it('suma montos sin errores de punto flotante', () => {
    expect(dinero('0.10').plus('0.20').toFixed(2)).to.equal('0.30');
  });

  it('redondea montos a 2 decimales hacia el centavo más cercano', () => {
    expect(dinero('10.005').toFixed(2)).to.equal('10.01');
    expect(dinero('10.004').toFixed(2)).to.equal('10.00');
  });

  it('redondea pesos a 2 decimales', () => {
    expect(peso('1.236').toFixed(2)).to.equal('1.24');
  });

  it('calcula el importe por pieza como precio por cantidad', () => {
    expect(importePorPieza('18.50', 3).toFixed(2)).to.equal('55.50');
  });

  it('rechaza cantidades de pieza no enteras o menores a 1', () => {
    expect(() => importePorPieza('18.50', 1.5)).to.throw(/entera/);
    expect(() => importePorPieza('18.50', 0)).to.throw(/entera/);
  });

  it('calcula el importe a granel como precio por kg por peso, redondeado al centavo', () => {
    expect(importePorPeso('32.90', '0.75').toFixed(2)).to.equal('24.68');
    expect(importePorPeso('28.00', '1.50').toFixed(2)).to.equal('42.00');
  });

  it('rechaza un peso de cero', () => {
    expect(() => importePorPeso('32.90', '0')).to.throw(/peso/);
  });
});
