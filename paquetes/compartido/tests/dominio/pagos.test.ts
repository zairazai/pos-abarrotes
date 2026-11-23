import { expect } from 'chai';
import { redondearEfectivo, liquidarPagos } from '../../src/dominio/pagos';

describe('Redondeo del efectivo', () => {
  const casos: [string, string][] = [
    ['47.30', '47.50'],
    ['47.50', '47.50'],
    ['47.00', '47.00'],
    ['47.01', '47.50'],
    ['47.51', '48.00'],
    ['0.01', '0.50'],
  ];
  for (const [monto, esperado] of casos) {
    it(`${monto} se redondea a ${esperado}`, () => {
      expect(redondearEfectivo(monto).toFixed(2)).to.equal(esperado);
    });
  }
});

describe('Liquidación de pagos', () => {
  it('un total de $47.30 pagado en efectivo se cobra como $47.50', () => {
    const r = liquidarPagos('47.30', [{ metodo: 'EFECTIVO', monto: '50.00' }]);
    expect(r.totalCobrado.toFixed(2)).to.equal('47.50');
    expect(r.redondeo.toFixed(2)).to.equal('0.20');
    expect(r.cambio.toFixed(2)).to.equal('2.50');
    expect(r.faltante.toFixed(2)).to.equal('0.00');
    expect(r.cubierto).to.equal(true);
  });

  it('en un pago mixto solo redondea la parte pagada en efectivo', () => {
    const r = liquidarPagos('100.30', [
      { metodo: 'TARJETA', monto: '50.00', referencia: 'A1234' },
      { metodo: 'EFECTIVO', monto: '60.00' },
    ]);
    expect(r.redondeo.toFixed(2)).to.equal('0.20');
    expect(r.totalCobrado.toFixed(2)).to.equal('100.50');
    expect(r.cambio.toFixed(2)).to.equal('9.50');
  });

  it('sin efectivo no hay redondeo', () => {
    const r = liquidarPagos('47.30', [{ metodo: 'TRANSFERENCIA', monto: '47.30', referencia: 'SPEI-99' }]);
    expect(r.redondeo.toFixed(2)).to.equal('0.00');
    expect(r.totalCobrado.toFixed(2)).to.equal('47.30');
    expect(r.cubierto).to.equal(true);
  });

  it('indica el faltante cuando los pagos no cubren el total', () => {
    const r = liquidarPagos('47.30', [{ metodo: 'EFECTIVO', monto: '20.00' }]);
    expect(r.cubierto).to.equal(false);
    expect(r.faltante.toFixed(2)).to.equal('27.50');
    expect(r.cambio.toFixed(2)).to.equal('0.00');
  });

  it('sin pagos, el faltante es el total', () => {
    const r = liquidarPagos('47.30', []);
    expect(r.faltante.toFixed(2)).to.equal('47.30');
    expect(r.cubierto).to.equal(false);
  });

  it('rechaza tarjeta o transferencia sin referencia', () => {
    expect(() => liquidarPagos('10.00', [{ metodo: 'TARJETA', monto: '10.00' }])).to.throw(/referencia/);
    expect(() =>
      liquidarPagos('10.00', [{ metodo: 'TRANSFERENCIA', monto: '10.00', referencia: '  ' }]),
    ).to.throw(/referencia/);
  });

  it('rechaza pagos con tarjeta o transferencia que superan el total, porque no dan cambio', () => {
    expect(() => liquidarPagos('10.00', [{ metodo: 'TARJETA', monto: '12.00', referencia: 'X1' }])).to.throw(
      /superar el total/,
    );
  });

  it('rechaza montos de pago de cero o negativos', () => {
    expect(() => liquidarPagos('10.00', [{ metodo: 'EFECTIVO', monto: '0' }])).to.throw(/mayor a cero/);
  });
});
