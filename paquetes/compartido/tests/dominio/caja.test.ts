import { expect } from 'chai';
import {
  DENOMINACIONES,
  efectivoEsperado,
  evaluarArqueo,
  revisarEfectivoParaPago,
  totalConteo,
} from '../../src/dominio/caja';

describe('Dominio de la caja', () => {
  describe('denominaciones', () => {
    it('billetes de 1000 a 20 y monedas de 20 a 50 centavos', () => {
      expect(DENOMINACIONES.map((d) => d.clave)).to.deep.equal([
        'B1000',
        'B500',
        'B200',
        'B100',
        'B50',
        'B20',
        'M20',
        'M10',
        'M5',
        'M2',
        'M1',
        'M050',
      ]);
      expect(DENOMINACIONES.find((d) => d.clave === 'M050')!.valor).to.equal('0.50');
    });
  });

  describe('totalConteo', () => {
    it('multiplica cada denominación por su cantidad y suma al centavo', () => {
      expect(totalConteo({ B500: 2, B20: 3, M050: 3, M1: 1 }).toFixed(2)).to.equal('1062.50');
    });

    it('un conteo vacío o en ceros vale cero', () => {
      expect(totalConteo({}).toFixed(2)).to.equal('0.00');
      expect(totalConteo({ B100: 0 }).toFixed(2)).to.equal('0.00');
    });

    it('rechaza cantidades negativas o con decimales', () => {
      expect(() => totalConteo({ B100: -1 })).to.throw(RangeError);
      expect(() => totalConteo({ B100: 1.5 })).to.throw(RangeError);
    });
  });

  describe('efectivoEsperado', () => {
    it('fondo más ingresos menos retiros', () => {
      const esperado = efectivoEsperado('500.00', [
        { tipo: 'INGRESO', monto: '200.00' },
        { tipo: 'RETIRO', monto: '150.50' },
        { tipo: 'RETIRO', monto: '49.50' },
      ]);
      expect(esperado.toFixed(2)).to.equal('500.00');
    });

    it('puede quedar negativo: un retiro no se compara con el esperado', () => {
      expect(efectivoEsperado('100', [{ tipo: 'RETIRO', monto: '300' }]).toFixed(2)).to.equal('-200.00');
    });

    it('el pago a proveedor sale de la caja y la venta en efectivo entra', () => {
      const esperado = efectivoEsperado('500.00', [
        { tipo: 'VENTA', monto: '120.50' },
        { tipo: 'PAGO_PROVEEDOR', monto: '372.00' },
      ]);
      expect(esperado.toFixed(2)).to.equal('248.50');
    });
    it('el reembolso de una devolución sale de la caja', () => {
      const esperado = efectivoEsperado('100.00', [{ tipo: 'DEVOLUCION', monto: '38.50' }]);
      expect(esperado.toFixed(2)).to.equal('61.50');
    });
  });

  describe('revisarEfectivoParaPago', () => {
    it('acepta el pago si el efectivo alcanza, aunque la caja quede en cero', () => {
      expect(() => revisarEfectivoParaPago('621.00', '700.00')).to.not.throw();
      expect(() => revisarEfectivoParaPago('621.00', '621')).to.not.throw();
    });

    it('no deja pagar más del efectivo que hay en la caja', () => {
      expect(() => revisarEfectivoParaPago('621.00', '500')).to.throw(
        RangeError,
        'En caja hay $500.00; no alcanza para pagar $621.00',
      );
      expect(() => revisarEfectivoParaPago('10', '-5')).to.throw(RangeError, /no alcanza/);
      expect(() => revisarEfectivoParaPago('60', '50', 'reembolsar')).to.throw(
        RangeError,
        'En caja hay $50.00; no alcanza para reembolsar $60.00',
      );
    });
  });

  describe('evaluarArqueo', () => {
    it('si el conteo coincide, cuadra en cualquier intento', () => {
      expect(evaluarArqueo(1, '500', '500.00')).to.deep.include({ resultado: 'CUADRA' });
      expect(evaluarArqueo(2, '500', '500.00')).to.deep.include({ resultado: 'CUADRA' });
    });

    it('con diferencia en el primer conteo pide recontar', () => {
      const r = evaluarArqueo(1, '480', '500');
      expect(r.resultado).to.equal('RECONTAR');
      expect(r.diferencia.toFixed(2)).to.equal('-20.00');
    });

    it('con diferencia en el reconteo exige justificación', () => {
      const r = evaluarArqueo(2, '510.50', '500');
      expect(r.resultado).to.equal('JUSTIFICAR');
      expect(r.diferencia.toFixed(2)).to.equal('10.50');
    });

    it('solo hay un reconteo', () => {
      expect(() => evaluarArqueo(3 as 1, '1', '1')).to.throw(RangeError);
    });
  });
});
