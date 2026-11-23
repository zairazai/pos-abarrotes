import { expect } from 'chai';
import { fechaLocal, inicioDelDia, finDelDia } from '../../src/comun/fechas';

// Sinaloa usa UTC-7 todo el año; "mismo día" y "caja del día" se calculan en hora local.
describe('Fechas en hora local de la tienda', () => {
  it('a las 23:30 locales todavía es el mismo día aunque en UTC ya sea el siguiente', () => {
    expect(fechaLocal(new Date('2026-10-18T06:30:00Z'))).to.equal('2026-10-17');
  });

  it('el día local empieza a las 00:00 y termina a las 23:59:59.999 de Mazatlán', () => {
    expect(inicioDelDia('2026-10-17').toISOString()).to.equal('2026-10-17T07:00:00.000Z');
    expect(finDelDia('2026-10-17').toISOString()).to.equal('2026-10-18T06:59:59.999Z');
  });
});
