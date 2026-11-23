import { expect } from 'chai';
import { calcularVenta, type RenglonACalcular } from '../../src/dominio/ventas';

const frijol: RenglonACalcular = { precio: '38.50', unidad: 'PIEZA', cantidad: '2' };
const queso: RenglonACalcular = { precio: '160.00', unidad: 'KG', cantidad: '0.75' };

const textos = (v: ReturnType<typeof calcularVenta>) => ({
  renglones: v.renglones.map((r) => [r.importe.toFixed(2), r.descuentoManual.toFixed(2)]),
  subtotal: v.subtotal.toFixed(2),
  descuentoManual: v.descuentoManual.toFixed(2),
  total: v.total.toFixed(2),
});

describe('Cálculo de la venta en el servidor', () => {
  it('suma importes por pieza y por kilogramo', () => {
    expect(textos(calcularVenta([frijol, queso]))).to.deep.equal({
      renglones: [
        ['77.00', '0.00'],
        ['120.00', '0.00'],
      ],
      subtotal: '197.00',
      descuentoManual: '0.00',
      total: '197.00',
    });
  });

  it('aplica descuentos por monto o porcentaje al renglón', () => {
    const v = calcularVenta([
      { ...frijol, descuento: { tipo: 'MONTO', valor: '7.00' } },
      { ...queso, descuento: { tipo: 'PORCENTAJE', valor: '10' } },
    ]);
    expect(textos(v)).to.deep.equal({
      renglones: [
        ['77.00', '7.00'],
        ['120.00', '12.00'],
      ],
      subtotal: '197.00',
      descuentoManual: '19.00',
      total: '178.00',
    });
  });

  it('el descuento a la venta se calcula sobre lo que queda después de los renglones', () => {
    const v = calcularVenta([{ ...frijol, descuento: { tipo: 'MONTO', valor: '17.00' } }], {
      tipo: 'PORCENTAJE',
      valor: '50',
    });
    expect(textos(v)).to.include({ descuentoManual: '47.00', total: '30.00' });
  });

  it('un descuento puede dejar la venta en cero, pero no en negativo', () => {
    expect(calcularVenta([frijol], { tipo: 'PORCENTAJE', valor: '100' }).total.toFixed(2)).to.equal('0.00');
    expect(() => calcularVenta([{ ...frijol, descuento: { tipo: 'MONTO', valor: '77.01' } }])).to.throw(
      RangeError,
      /excede/,
    );
    expect(() => calcularVenta([frijol], { tipo: 'MONTO', valor: '100' })).to.throw(RangeError, /excede/);
  });

  it('las piezas deben ser enteras', () => {
    expect(() => calcularVenta([{ ...frijol, cantidad: '1.5' }])).to.throw(RangeError, /piezas/);
  });

  it('el porcentaje no pasa de 100', () => {
    expect(() => calcularVenta([frijol], { tipo: 'PORCENTAJE', valor: '101' })).to.throw(RangeError);
  });

  it('una venta necesita al menos un producto', () => {
    expect(() => calcularVenta([])).to.throw(RangeError);
  });

  describe('con promociones', () => {
    it('la promoción se resta sola y el ahorro queda aparte', () => {
      const v = calcularVenta([
        { ...frijol, cantidad: '3', promocion: { tipo: 'NXM', lleva: 3, paga: 2 } },
        queso,
      ]);
      expect(v.renglones[0]!.descuentoPromocion.toFixed(2)).to.equal('38.50');
      expect(v.renglones[1]!.descuentoPromocion.toFixed(2)).to.equal('0.00');
      expect(v.ahorroPromociones.toFixed(2)).to.equal('38.50');
      expect(v.subtotal.toFixed(2)).to.equal('235.50');
      expect(v.total.toFixed(2)).to.equal('197.00');
    });

    it('el descuento manual se aplica sobre lo que queda después de la promoción', () => {
      const v = calcularVenta([
        {
          ...frijol,
          promocion: { tipo: 'PRECIO_ESPECIAL', precio: '30.00' },
          descuento: { tipo: 'PORCENTAJE', valor: '10' },
        },
      ]);
      // 77.00 - 17.00 de promoción = 60.00; el 10 % son 6.00.
      expect(v.renglones[0]!.descuentoManual.toFixed(2)).to.equal('6.00');
      expect(v.total.toFixed(2)).to.equal('54.00');
    });

    it('el descuento a la venta también se calcula sin lo de las promociones', () => {
      const v = calcularVenta([{ ...frijol, promocion: { tipo: 'PRECIO_ESPECIAL', precio: '30.00' } }], {
        tipo: 'PORCENTAJE',
        valor: '50',
      });
      expect(v.descuentoManual.toFixed(2)).to.equal('30.00');
      expect(v.total.toFixed(2)).to.equal('30.00');
    });
  });
});
