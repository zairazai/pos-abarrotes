import { expect } from 'chai';
import {
  esquemaClaveIdempotencia,
  esquemaCobro,
  esquemaFolio,
  esquemaVentaAbierta,
} from '../../src/esquemas/ventas';

const ID = '3f1c2b8e-8a4d-4c55-9a77-6c1d2f0e9b10';
const cobro = {
  iniciadaPor: ID,
  renglones: [{ productoId: ID, cantidad: '2' }],
  pagos: [{ metodo: 'EFECTIVO', monto: '100' }],
};

describe('Esquemas de ventas', () => {
  it('acepta un cobro con pago mixto y referencia', () => {
    const r = esquemaCobro.safeParse({
      ...cobro,
      pagos: [
        { metodo: 'EFECTIVO', monto: '50' },
        { metodo: 'TARJETA', monto: '27.00', referencia: '123456' },
      ],
    });
    expect(r.success).to.equal(true);
  });

  it('exige la referencia en tarjeta y transferencia', () => {
    const r = esquemaCobro.safeParse({ ...cobro, pagos: [{ metodo: 'TRANSFERENCIA', monto: '10' }] });
    expect(r.success).to.equal(false);
    expect(r.error!.issues[0]!.path).to.deep.equal(['pagos', 0, 'referencia']);
  });

  it('no acepta precios ni totales enviados por la pantalla', () => {
    expect(
      esquemaCobro.safeParse({ ...cobro, renglones: [{ productoId: ID, cantidad: '1', precio: '1.00' }] })
        .success,
    ).to.equal(false);
    expect(esquemaCobro.safeParse({ ...cobro, total: '1.00' }).success).to.equal(false);
  });

  it('el descuento en porcentaje no pasa de 100', () => {
    expect(
      esquemaCobro.safeParse({ ...cobro, descuento: { tipo: 'PORCENTAJE', valor: '101' } }).success,
    ).to.equal(false);
    expect(esquemaCobro.safeParse({ ...cobro, descuento: { tipo: 'MONTO', valor: '101' } }).success).to.equal(
      true,
    );
  });

  it('la venta necesita al menos un producto con cantidad positiva', () => {
    expect(esquemaCobro.safeParse({ ...cobro, renglones: [] }).success).to.equal(false);
    expect(
      esquemaVentaAbierta.safeParse({ iniciadaPor: ID, renglones: [{ productoId: ID, cantidad: '0' }] })
        .success,
    ).to.equal(false);
  });

  it('la clave de idempotencia es un UUID y el folio un entero positivo', () => {
    expect(esquemaClaveIdempotencia.safeParse(ID).success).to.equal(true);
    expect(esquemaClaveIdempotencia.safeParse('venta-1').success).to.equal(false);
    expect(esquemaFolio.parse({ folio: '15' }).folio).to.equal(15);
    expect(esquemaFolio.safeParse({ folio: 'abc' }).success).to.equal(false);
  });
});
