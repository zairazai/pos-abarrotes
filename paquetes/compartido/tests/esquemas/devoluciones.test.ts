import { expect } from 'chai';
import { esquemaDevolucionNueva } from '../../src/esquemas/devoluciones';

describe('Esquema de devolución', () => {
  const valida = {
    folio: 12,
    motivo: 'Venía caducado',
    renglones: [{ renglon: 1, cantidad: '1', destino: 'MERMA' }],
  };

  it('acepta folio, motivo y por renglón la cantidad y su destino; el reembolso es en efectivo', () => {
    expect(esquemaDevolucionNueva.parse(valida)).to.deep.equal({ ...valida, reembolso: 'EFECTIVO' });
  });

  it('también acepta el cambio por producto con saldo a favor', () => {
    expect(esquemaDevolucionNueva.parse({ ...valida, reembolso: 'SALDO_FAVOR' }).reembolso).to.equal(
      'SALDO_FAVOR',
    );
    const otra = esquemaDevolucionNueva.safeParse({ ...valida, reembolso: 'VALE' });
    expect(otra.error!.issues[0]!.message).to.equal('Debe ser EFECTIVO o SALDO_FAVOR');
  });

  it('exige el motivo y un destino válido', () => {
    const sinMotivo = esquemaDevolucionNueva.safeParse({ ...valida, motivo: ' ' });
    expect(sinMotivo.error!.issues[0]!.path).to.deep.equal(['motivo']);
    const destino = esquemaDevolucionNueva.safeParse({
      ...valida,
      renglones: [{ renglon: 1, cantidad: '1', destino: 'BASURA' }],
    });
    expect(destino.error!.issues[0]!.message).to.equal('Debe ser INVENTARIO o MERMA');
  });

  it('necesita al menos un renglón', () => {
    expect(esquemaDevolucionNueva.safeParse({ ...valida, renglones: [] }).success).to.equal(false);
  });
});
