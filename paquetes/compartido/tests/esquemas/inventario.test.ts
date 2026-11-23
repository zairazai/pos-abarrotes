import { expect } from 'chai';
import {
  esquemaEntradaNueva,
  esquemaPagoProveedor,
  esquemaProveedorNuevo,
  esquemaAjusteNuevo,
  esquemaSalidaNueva,
} from '../../src/esquemas/inventario';

describe('Esquema de proveedor', () => {
  it('acepta nombre y teléfono y quita los espacios sobrantes', () => {
    const r = esquemaProveedorNuevo.parse({ nombre: '  Abarrotera del Valle ', telefono: '667 123 4567' });
    expect(r).to.deep.equal({ nombre: 'Abarrotera del Valle', telefono: '667 123 4567' });
  });

  it('el teléfono es opcional y queda vacío', () => {
    expect(esquemaProveedorNuevo.parse({ nombre: 'Lala' }).telefono).to.equal('');
  });

  it('exige el nombre', () => {
    const r = esquemaProveedorNuevo.safeParse({ nombre: '   ' });
    expect(r.success).to.equal(false);
    expect(r.error!.issues[0]!.path).to.deep.equal(['nombre']);
  });

  it('el teléfono solo admite dígitos, espacios, guiones, paréntesis y +', () => {
    expect(esquemaProveedorNuevo.safeParse({ nombre: 'Lala', telefono: '(667) 123-45-67' }).success).to.equal(
      true,
    );
    expect(esquemaProveedorNuevo.safeParse({ nombre: 'Lala', telefono: 'sin teléfono' }).success).to.equal(
      false,
    );
  });

  it('no acepta campos que no existen', () => {
    expect(esquemaProveedorNuevo.safeParse({ nombre: 'Lala', correo: 'x@y.com' }).success).to.equal(false);
  });
});

const renglon = {
  productoId: '3f1c2b8e-8a4d-4c55-9a77-6c1d2f0e9b10',
  cantidad: '12',
  costoUnitario: '31.00',
  caducidad: '2026-12-31',
};
const entrada = {
  proveedorId: '9b2c1a7e-1d4f-4a3b-8c6d-2e5f7a9b0c1d',
  folioNota: 'A-1234',
  renglones: [renglon],
};

describe('Esquema de entrada de mercancía', () => {
  it('acepta una entrada completa', () => {
    expect(esquemaEntradaNueva.parse(entrada).renglones[0]).to.deep.equal(renglon);
  });

  it('caducidad null significa "No aplica"', () => {
    const r = esquemaEntradaNueva.parse({ ...entrada, renglones: [{ ...renglon, caducidad: null }] });
    expect(r.renglones[0]!.caducidad).to.equal(null);
  });

  it('la caducidad es obligatoria: hay que mandar una fecha o null', () => {
    const { caducidad: _, ...sinCaducidad } = renglon;
    const r = esquemaEntradaNueva.safeParse({ ...entrada, renglones: [sinCaducidad] });
    expect(r.success).to.equal(false);
    expect(r.error!.issues[0]!.path).to.deep.equal(['renglones', 0, 'caducidad']);
  });

  it('rechaza fechas que no existen', () => {
    const r = esquemaEntradaNueva.safeParse({
      ...entrada,
      renglones: [{ ...renglon, caducidad: '2026-02-30' }],
    });
    expect(r.success).to.equal(false);
  });

  it('exige folio de la nota y al menos un producto', () => {
    expect(esquemaEntradaNueva.safeParse({ ...entrada, folioNota: ' ' }).success).to.equal(false);
    expect(esquemaEntradaNueva.safeParse({ ...entrada, renglones: [] }).success).to.equal(false);
  });

  it('cantidad y costo deben ser mayores a cero', () => {
    expect(
      esquemaEntradaNueva.safeParse({ ...entrada, renglones: [{ ...renglon, cantidad: '0' }] }).success,
    ).to.equal(false);
    expect(
      esquemaEntradaNueva.safeParse({ ...entrada, renglones: [{ ...renglon, costoUnitario: '0' }] }).success,
    ).to.equal(false);
  });

  it('el pago es opcional; si viene, el monto debe ser mayor a cero', () => {
    expect(esquemaEntradaNueva.parse(entrada).pago).to.equal(undefined);
    expect(esquemaEntradaNueva.parse({ ...entrada, pago: { monto: '372.00' } }).pago).to.deep.equal({
      monto: '372.00',
    });
    expect(esquemaEntradaNueva.safeParse({ ...entrada, pago: { monto: '0' } }).success).to.equal(false);
  });
});

describe('Esquema de pago a proveedor', () => {
  it('acepta monto y motivo; el motivo es opcional', () => {
    expect(esquemaPagoProveedor.parse({ monto: '100', motivo: ' Pago de contado ' })).to.deep.equal({
      monto: '100',
      motivo: 'Pago de contado',
    });
    expect(esquemaPagoProveedor.parse({ monto: '100' }).motivo).to.equal(undefined);
  });

  it('rechaza montos no positivos y campos que no existen', () => {
    expect(esquemaPagoProveedor.safeParse({ monto: '0' }).success).to.equal(false);
    expect(esquemaPagoProveedor.safeParse({ monto: '-5' }).success).to.equal(false);
    expect(esquemaPagoProveedor.safeParse({ monto: '5', tipo: 'RETIRO' }).success).to.equal(false);
  });
});

describe('Esquema de salida de inventario', () => {
  const salida = {
    tipo: 'MERMA',
    productoId: '3f1c2b8e-8a4d-4c55-9a77-6c1d2f0e9b10',
    cantidad: '2',
    motivo: 'Caducado',
  };

  it('acepta merma o consumo propio; el lote y el comentario son opcionales', () => {
    expect(esquemaSalidaNueva.parse(salida)).to.deep.equal(salida);
    const consumo = esquemaSalidaNueva.parse({
      ...salida,
      tipo: 'CONSUMO',
      loteId: '9b2c1a7e-1d4f-4a3b-8c6d-2e5f7a9b0c1d',
      comentario: 'Para la comida',
    });
    expect(consumo).to.include({ tipo: 'CONSUMO', comentario: 'Para la comida' });
  });

  it('el motivo es obligatorio', () => {
    const r = esquemaSalidaNueva.safeParse({ ...salida, motivo: '  ' });
    expect(r.success).to.equal(false);
    expect(r.error!.issues[0]!.path).to.deep.equal(['motivo']);
  });

  it('solo admite merma o consumo y una cantidad mayor a cero', () => {
    expect(esquemaSalidaNueva.safeParse({ ...salida, tipo: 'VENTA' }).success).to.equal(false);
    expect(esquemaSalidaNueva.safeParse({ ...salida, cantidad: '0' }).success).to.equal(false);
  });
});

describe('Esquema de ajuste por conteo', () => {
  const productoId = '3f1c2b8e-8a4d-4c55-9a77-6c1d2f0e9b10';

  it('acepta lo contado, incluso cero', () => {
    expect(esquemaAjusteNuevo.parse({ productoId, contada: '0' })).to.deep.equal({
      productoId,
      contada: '0',
    });
  });

  it('lo contado es obligatorio y no puede ser negativo', () => {
    expect(esquemaAjusteNuevo.safeParse({ productoId }).success).to.equal(false);
    expect(esquemaAjusteNuevo.safeParse({ productoId, contada: '-1' }).success).to.equal(false);
  });
});
