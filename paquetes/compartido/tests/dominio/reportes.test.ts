import { expect } from 'chai';
import { gananciaDeRenglon, margen, periodoReporte } from '../../src/dominio/reportes';

describe('Reportes', () => {
  const HOY = '2026-10-17';

  describe('periodoReporte', () => {
    it('sin fechas es hoy; sin desde empieza el mismo día que termina', () => {
      expect(periodoReporte(undefined, undefined, HOY)).to.deep.equal({ desde: HOY, hasta: HOY });
      expect(periodoReporte(undefined, '2026-10-10', HOY)).to.deep.equal({
        desde: '2026-10-10',
        hasta: '2026-10-10',
      });
      expect(periodoReporte('2026-10-01', undefined, HOY)).to.deep.equal({ desde: '2026-10-01', hasta: HOY });
    });

    it('desde no puede ser posterior a hasta', () => {
      expect(() => periodoReporte('2026-10-18', '2026-10-17', HOY)).to.throw(RangeError, 'posterior');
    });

    it('acepta hasta 366 días, incluidos los dos extremos', () => {
      expect(periodoReporte('2025-10-17', '2026-10-17', HOY).desde).to.equal('2025-10-17');
      expect(() => periodoReporte('2025-10-16', '2026-10-17', HOY)).to.throw(RangeError, '366');
    });
  });

  describe('gananciaDeRenglon', () => {
    it('es lo cobrado menos el costo de cada lote', () => {
      const r = gananciaDeRenglon({
        neto: '115.50', // 3 × 38.50
        devuelto: '0',
        vendidos: [
          { cantidad: '2', costo: '30' },
          { cantidad: '1', costo: '31.25' },
        ],
        devueltos: [],
      });
      expect(r.venta.toFixed(2)).to.equal('115.50');
      expect(r.costo.toFixed(2)).to.equal('91.25');
      expect(r.ganancia.toFixed(2)).to.equal('24.25');
    });

    it('lo devuelto se resta de la venta y su costo regresa con su lote', () => {
      const r = gananciaDeRenglon({
        neto: '115.50',
        devuelto: '38.50',
        vendidos: [{ cantidad: '3', costo: '30' }],
        devueltos: [{ cantidad: '1', costo: '30' }],
      });
      expect(r.venta.toFixed(2)).to.equal('77.00');
      expect(r.costo.toFixed(2)).to.equal('60.00');
      expect(r.ganancia.toFixed(2)).to.equal('17.00');
    });

    it('a granel multiplica el peso por el costo por kilo', () => {
      const r = gananciaDeRenglon({
        neto: '37.50',
        devuelto: '0',
        vendidos: [{ cantidad: '1.25', costo: '22.40' }],
        devueltos: [],
      });
      expect(r.costo.toFixed(2)).to.equal('28.00');
    });
  });

  describe('margen', () => {
    it('es la ganancia sobre la venta, con un decimal', () => {
      expect(margen('115.50', '24.25')).to.equal('21.0');
      expect(margen('100', '-5')).to.equal('-5.0');
    });

    it('sin venta no hay margen', () => {
      expect(margen('0', '0')).to.equal(null);
    });
  });
});
