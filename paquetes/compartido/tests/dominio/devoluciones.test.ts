import { expect } from 'chai';
import {
  aplicarSaldo,
  netoPorRenglon,
  planDevolucion,
  reembolsoEfectivo,
  type RenglonDevolvible,
} from '../../src/dominio/devoluciones';

const textos = (valores: { toFixed(n: number): string }[]) => valores.map((v) => v.toFixed(2));

describe('Devoluciones', () => {
  describe('netoPorRenglon', () => {
    it('sin descuento general, es el importe menos el descuento del renglón', () => {
      const neto = netoPorRenglon(
        [
          { importe: '77.00', descuento: '0' },
          { importe: '30.00', descuento: '5.00' },
        ],
        '0',
      );
      expect(textos(neto)).to.deep.equal(['77.00', '25.00']);
    });

    it('reparte el descuento general según lo que pesa cada renglón y la suma da el total', () => {
      // Bases de 60 y 30 con descuento general de 10: a uno le tocan 6.67 y al otro 3.33.
      const neto = netoPorRenglon(
        [
          { importe: '60.00', descuento: '0' },
          { importe: '35.00', descuento: '5.00' },
        ],
        '10.00',
      );
      expect(textos(neto)).to.deep.equal(['53.33', '26.67']);
    });
  });

  describe('planDevolucion', () => {
    const renglones: RenglonDevolvible[] = [
      { renglon: 1, unidad: 'PIEZA', vendida: '2', devuelta: '0', neto: '77.00' },
      { renglon: 2, unidad: 'KG', vendida: '1.5', devuelta: '0.5', neto: '45.00' },
    ];

    it('calcula lo pagado por lo que se devuelve, en proporción a lo vendido', () => {
      const plan = planDevolucion(renglones, [
        { renglon: 1, cantidad: '1' },
        { renglon: 2, cantidad: '0.5' },
      ]);
      expect(textos(plan.montos)).to.deep.equal(['38.50', '15.00']);
      expect(plan.monto.toFixed(2)).to.equal('53.50');
      expect(plan.completa).to.equal(false);
    });

    it('es completa si con esta devolución ya no queda nada por devolver', () => {
      const plan = planDevolucion(renglones, [
        { renglon: 1, cantidad: '2' },
        { renglon: 2, cantidad: '1' },
      ]);
      expect(plan.completa).to.equal(true);
    });

    it('no deja devolver más de lo que queda, ni renglones que no son de la venta', () => {
      expect(() => planDevolucion(renglones, [{ renglon: 2, cantidad: '1.5' }])).to.throw(
        RangeError,
        'Del renglón 2 solo quedan 1.00 por devolver',
      );
      expect(() => planDevolucion(renglones, [{ renglon: 3, cantidad: '1' }])).to.throw(
        RangeError,
        'El renglón 3 no es de esta venta',
      );
    });

    it('las piezas son enteras, la cantidad mayor a cero y cada renglón va una vez', () => {
      expect(() => planDevolucion(renglones, [{ renglon: 1, cantidad: '0.5' }])).to.throw(
        RangeError,
        /enter/,
      );
      expect(() => planDevolucion(renglones, [{ renglon: 1, cantidad: '0' }])).to.throw(
        RangeError,
        /mayor a cero/,
      );
      expect(() =>
        planDevolucion(renglones, [
          { renglon: 1, cantidad: '1' },
          { renglon: 1, cantidad: '1' },
        ]),
      ).to.throw(RangeError, /una sola vez/);
    });
  });

  describe('aplicarSaldo (cambio por producto)', () => {
    it('si la venta nueva cuesta más, el saldo cubre una parte y el resto se paga', () => {
      const r = aplicarSaldo('50.00', '38.50');
      expect(textos([r.aplicado, r.restante, r.entrega])).to.deep.equal(['38.50', '11.50', '0.00']);
    });

    it('si cuesta menos, la diferencia se entrega en efectivo redondeada a 50 centavos', () => {
      const r = aplicarSaldo('50.00', '77.00');
      expect(textos([r.aplicado, r.restante, r.entrega])).to.deep.equal(['50.00', '0.00', '27.00']);
      expect(aplicarSaldo('10.00', '38.20').entrega.toFixed(2)).to.equal('28.50');
    });
  });

  describe('reembolsoEfectivo', () => {
    it('redondea a los 50 centavos de arriba sin pasar de lo que falta reembolsar', () => {
      expect(reembolsoEfectivo('38.20', '91.50', false).toFixed(2)).to.equal('38.50');
      expect(reembolsoEfectivo('91.30', '91.00', false).toFixed(2)).to.equal('91.00');
    });

    it('si se devuelve todo, entrega exactamente lo que falta', () => {
      expect(reembolsoEfectivo('53.10', '53.30', true).toFixed(2)).to.equal('53.30');
    });
  });
});
