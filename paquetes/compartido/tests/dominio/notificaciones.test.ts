import { expect } from 'chai';
import { textoPromocion, textoResumenDia } from '../../src/dominio/notificaciones';

describe('Textos de las notificaciones', () => {
  const base = {
    tienda: 'Abarrotes Mary',
    producto: 'Frijol negro 1 kg',
    inicio: '2026-11-01',
    fin: '2026-11-07',
  };

  it('describe cada tipo de promoción con su vigencia', () => {
    expect(textoPromocion({ ...base, regla: { tipo: 'PRECIO_ESPECIAL', precio: '30' } })).to.equal(
      'Abarrotes Mary: Frijol negro 1 kg a $30.00. Del 2026-11-01 al 2026-11-07.',
    );
    expect(textoPromocion({ ...base, regla: { tipo: 'NXM', lleva: 3, paga: 2 } })).to.equal(
      'Abarrotes Mary: Frijol negro 1 kg 3x2. Del 2026-11-01 al 2026-11-07.',
    );
    expect(
      textoPromocion({ ...base, regla: { tipo: 'MAYOREO', cantidadMinima: '6', precio: '15.00' } }),
    ).to.equal('Abarrotes Mary: Frijol negro 1 kg desde 6 a $15.00. Del 2026-11-01 al 2026-11-07.');
  });

  const dia = {
    fecha: '2026-10-17',
    ventas: 12,
    total: '1500.50',
    devoluciones: '38.50',
    ganancia: '420.00',
  };

  it('resume el día y no habla de diferencia si el arqueo cuadró', () => {
    expect(textoResumenDia({ ...dia, diferencia: '0', justificacion: null })).to.equal(
      'Resumen del 2026-10-17: 12 ventas por $1500.50. Devoluciones: $38.50. Ganancia aproximada: $420.00.',
    );
  });

  it('incluye la diferencia del arqueo con su justificación', () => {
    expect(textoResumenDia({ ...dia, diferencia: '-25.00', justificacion: 'Cambio mal dado' })).to.match(
      /Diferencia del arqueo: -\$25\.00 \(Cambio mal dado\)\.$/,
    );
  });
});
