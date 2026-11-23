import { expect } from 'chai';
import { descuentoPromocion, estadoPromocion, revisarPromocion } from '../../src/dominio/promociones';

describe('Descuento de promociones', () => {
  describe('mayoreo', () => {
    const promo = { tipo: 'MAYOREO', cantidadMinima: '6', precio: '15.00' } as const;

    it('aplica el precio de mayoreo a todas las unidades al llegar a la cantidad mínima', () => {
      expect(descuentoPromocion({ precio: '18.00', cantidad: '6' }, promo).toFixed(2)).to.equal('18.00');
    });

    it('no descuenta por debajo de la cantidad mínima', () => {
      expect(descuentoPromocion({ precio: '18.00', cantidad: '5' }, promo).toFixed(2)).to.equal('0.00');
    });
  });

  describe('NxM', () => {
    const dosPorUno = { tipo: 'NXM', lleva: 2, paga: 1 } as const;
    const tresPorDos = { tipo: 'NXM', lleva: 3, paga: 2 } as const;

    it('2x1 con 5 piezas regala 2', () => {
      expect(descuentoPromocion({ precio: '12.50', cantidad: '5' }, dosPorUno).toFixed(2)).to.equal('25.00');
    });

    it('3x2 con 3 piezas regala 1', () => {
      expect(descuentoPromocion({ precio: '20.00', cantidad: '3' }, tresPorDos).toFixed(2)).to.equal('20.00');
    });

    it('3x2 con 2 piezas no regala ninguna', () => {
      expect(descuentoPromocion({ precio: '20.00', cantidad: '2' }, tresPorDos).toFixed(2)).to.equal('0.00');
    });
  });

  describe('precio especial', () => {
    it('descuenta la diferencia de precio por cada unidad', () => {
      const promo = { tipo: 'PRECIO_ESPECIAL', precio: '25.00' } as const;
      expect(descuentoPromocion({ precio: '29.90', cantidad: '2' }, promo).toFixed(2)).to.equal('9.80');
    });

    it('funciona con productos a granel', () => {
      const promo = { tipo: 'PRECIO_ESPECIAL', precio: '30.00' } as const;
      expect(descuentoPromocion({ precio: '32.90', cantidad: '0.75' }, promo).toFixed(2)).to.equal('2.18');
    });

    it('no descuenta si el precio especial no es menor al precio normal', () => {
      const promo = { tipo: 'PRECIO_ESPECIAL', precio: '35.00' } as const;
      expect(descuentoPromocion({ precio: '29.90', cantidad: '1' }, promo).toFixed(2)).to.equal('0.00');
    });
  });
});

describe('Configuración de promociones', () => {
  const HOY = '2026-10-17';
  const frijol = { precio: '38.50', unidad: 'PIEZA' } as const;
  const queso = { precio: '160.00', unidad: 'KG' } as const;

  describe('estadoPromocion', () => {
    it('programada antes del inicio, activa en sus días (incluidos) y vencida después', () => {
      expect(estadoPromocion('2026-10-18', '2026-10-20', HOY)).to.equal('PROGRAMADA');
      expect(estadoPromocion(HOY, HOY, HOY)).to.equal('ACTIVA');
      expect(estadoPromocion('2026-10-10', HOY, HOY)).to.equal('ACTIVA');
      expect(estadoPromocion('2026-10-10', '2026-10-16', HOY)).to.equal('VENCIDA');
    });
  });

  describe('revisarPromocion', () => {
    it('acepta un precio especial menor al normal desde hoy', () => {
      expect(() =>
        revisarPromocion({ tipo: 'PRECIO_ESPECIAL', precio: '35.00' }, frijol, HOY, HOY),
      ).to.not.throw();
    });

    it('el precio de mayoreo o especial debe ser menor al precio normal', () => {
      expect(() => revisarPromocion({ tipo: 'PRECIO_ESPECIAL', precio: '38.50' }, frijol, HOY, HOY)).to.throw(
        RangeError,
        'El precio de la promoción debe ser menor al precio normal (38.50)',
      );
      expect(() =>
        revisarPromocion({ tipo: 'MAYOREO', cantidadMinima: '6', precio: '40' }, frijol, HOY, HOY),
      ).to.throw(RangeError, /menor al precio normal/);
    });

    it('el mayoreo pide más de una unidad y piezas enteras', () => {
      expect(() =>
        revisarPromocion({ tipo: 'MAYOREO', cantidadMinima: '1', precio: '30' }, frijol, HOY, HOY),
      ).to.throw(RangeError, 'La cantidad mínima de mayoreo debe ser mayor a 1');
      expect(() =>
        revisarPromocion({ tipo: 'MAYOREO', cantidadMinima: '2.5', precio: '30' }, frijol, HOY, HOY),
      ).to.throw(RangeError, /enter/);
      expect(() =>
        revisarPromocion({ tipo: 'MAYOREO', cantidadMinima: '2.5', precio: '150' }, queso, HOY, HOY),
      ).to.not.throw();
    });

    it('el NxM solo es para productos por pieza', () => {
      expect(() => revisarPromocion({ tipo: 'NXM', lleva: 2, paga: 1 }, queso, HOY, HOY)).to.throw(
        RangeError,
        'El NxM solo aplica a productos por pieza',
      );
    });

    it('no puede empezar antes de hoy', () => {
      expect(() => revisarPromocion({ tipo: 'NXM', lleva: 2, paga: 1 }, frijol, '2026-10-16', HOY)).to.throw(
        RangeError,
        'La promoción no puede empezar antes de hoy',
      );
    });
  });
});
