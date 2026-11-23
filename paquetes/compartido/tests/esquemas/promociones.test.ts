import { expect } from 'chai';
import { esquemaPromocionNueva } from '../../src/esquemas/promociones';

describe('Esquema de promoción', () => {
  const base = {
    productoId: '3f1c2b8e-8a4d-4c55-9a77-6c1d2f0e9b10',
    inicio: '2026-11-01',
    fin: '2026-11-07',
  };

  it('acepta los tres tipos con sus condiciones', () => {
    expect(
      esquemaPromocionNueva.safeParse({ ...base, tipo: 'MAYOREO', cantidadMinima: '6', precio: '15.00' })
        .success,
    ).to.equal(true);
    expect(esquemaPromocionNueva.safeParse({ ...base, tipo: 'NXM', lleva: 3, paga: 2 }).success).to.equal(
      true,
    );
    expect(
      esquemaPromocionNueva.safeParse({ ...base, tipo: 'PRECIO_ESPECIAL', precio: '30.00' }).success,
    ).to.equal(true);
  });

  it('en NxM se paga menos de lo que se lleva', () => {
    const r = esquemaPromocionNueva.safeParse({ ...base, tipo: 'NXM', lleva: 2, paga: 2 });
    expect(r.error!.issues[0]!.message).to.equal('Se paga menos de lo que se lleva, por ejemplo 2x1 o 3x2');
  });

  it('el fin no puede ser antes del inicio y cada tipo solo lleva sus campos', () => {
    const fechas = esquemaPromocionNueva.safeParse({
      ...base,
      fin: '2026-10-31',
      tipo: 'PRECIO_ESPECIAL',
      precio: '30',
    });
    expect(fechas.error!.issues[0]!.path).to.deep.equal(['fin']);
    const extra = esquemaPromocionNueva.safeParse({
      ...base,
      tipo: 'PRECIO_ESPECIAL',
      precio: '30',
      lleva: 2,
    });
    expect(extra.success).to.equal(false);
  });
});
