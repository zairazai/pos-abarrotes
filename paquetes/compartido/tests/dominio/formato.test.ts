import { expect } from 'chai';
import { formatoMoneda, normalizarTexto } from '../../src/dominio/formato';

describe('Formato de moneda', () => {
  it('usa el signo de pesos y dos decimales', () => {
    expect(formatoMoneda('47.5')).to.equal('$47.50');
    expect(formatoMoneda('0')).to.equal('$0.00');
  });

  it('separa los miles con coma', () => {
    expect(formatoMoneda('1234567.891')).to.equal('$1,234,567.89');
  });

  it('muestra el signo menos antes del signo de pesos', () => {
    expect(formatoMoneda('-12.3')).to.equal('-$12.30');
  });
});

describe('Normalización de texto para búsquedas', () => {
  it('ignora acentos, mayúsculas y espacios repetidos', () => {
    expect(normalizarTexto('  Jamón   PIÑA Ácida ')).to.equal('jamon pina acida');
  });
});
