import { expect } from 'chai';
import {
  caducaPronto,
  diasParaCaducar,
  enExistenciaMinima,
  fraseDeAlertas,
  lotePropuesto,
  ordenarPorCaducidad,
  planAjuste,
  planDescuento,
  resumenCaducidad,
  revisionPendiente,
  revisarPagoNota,
  revisarSalida,
  totalEntrada,
  type LoteDisponible,
} from '../../src/dominio/inventario';

const lote = (
  id: string,
  caducidad: string | null,
  existencia: string,
  creadoEn = '2026-10-01',
): LoteDisponible => ({
  id,
  caducidad,
  existencia,
  creadoEn,
});

/** Pasa los consumos a texto para compararlos fácil. */
const plan = (lotes: LoteDisponible[], cantidad: string) => {
  const r = planDescuento(lotes, cantidad);
  return {
    consumos: r.consumos.map((c) => [c.loteId, c.cantidad.toFixed(2)]),
    faltante: r.faltante.toFixed(2),
  };
};

describe('Descuento de inventario por caducidad', () => {
  describe('ordenarPorCaducidad', () => {
    it('primero la caducidad más próxima, aunque ya haya pasado; los "No aplica" al final', () => {
      const orden = ordenarPorCaducidad([
        lote('sin', null, '1'),
        lote('nov', '2026-11-30', '1'),
        lote('caducado', '2026-10-01', '1'),
        lote('oct', '2026-10-20', '1'),
      ]);
      expect(orden.map((l) => l.id)).to.deep.equal(['caducado', 'oct', 'nov', 'sin']);
    });

    it('con la misma caducidad, o ambos "No aplica", va primero el lote más antiguo', () => {
      const orden = ordenarPorCaducidad([
        lote('nuevo', '2026-11-01', '1', '2026-10-10'),
        lote('viejo', '2026-11-01', '1', '2026-10-01'),
        lote('sinNuevo', null, '1', '2026-10-10'),
        lote('sinViejo', null, '1', '2026-10-01'),
      ]);
      expect(orden.map((l) => l.id)).to.deep.equal(['viejo', 'nuevo', 'sinViejo', 'sinNuevo']);
    });

    it('no modifica la lista original', () => {
      const lotes = [lote('b', '2026-12-01', '1'), lote('a', '2026-11-01', '1')];
      ordenarPorCaducidad(lotes);
      expect(lotes.map((l) => l.id)).to.deep.equal(['b', 'a']);
    });
  });

  describe('planDescuento', () => {
    it('toma todo del lote más próximo a caducar si alcanza', () => {
      expect(plan([lote('nov', '2026-11-30', '10'), lote('oct', '2026-10-20', '5')], '3')).to.deep.equal({
        consumos: [['oct', '3.00']],
        faltante: '0.00',
      });
    });

    it('reparte entre lotes cuando uno no alcanza', () => {
      expect(plan([lote('nov', '2026-11-30', '10'), lote('oct', '2026-10-20', '5')], '8')).to.deep.equal({
        consumos: [
          ['oct', '5.00'],
          ['nov', '3.00'],
        ],
        faltante: '0.00',
      });
    });

    it('funciona con kilos a granel con 2 decimales', () => {
      expect(plan([lote('a', '2026-10-20', '0.75'), lote('b', '2026-11-20', '3.40')], '1.25')).to.deep.equal({
        consumos: [
          ['a', '0.75'],
          ['b', '0.50'],
        ],
        faltante: '0.00',
      });
    });

    it('si no alcanza, el faltante se resta del último lote del orden, que queda negativo', () => {
      expect(plan([lote('sin', null, '2'), lote('oct', '2026-10-20', '1')], '5')).to.deep.equal({
        consumos: [
          ['oct', '1.00'],
          ['sin', '4.00'],
        ],
        faltante: '2.00',
      });
    });

    it('salta los lotes en cero o negativos, pero el faltante cae en el último del orden', () => {
      expect(
        plan([lote('cero', '2026-10-18', '0'), lote('neg', null, '-2'), lote('ok', '2026-11-01', '1')], '3'),
      ).to.deep.equal({
        consumos: [
          ['ok', '1.00'],
          ['neg', '2.00'],
        ],
        faltante: '2.00',
      });
    });

    it('sin lotes no hay consumos y todo es faltante', () => {
      expect(plan([], '2.5')).to.deep.equal({ consumos: [], faltante: '2.50' });
    });

    it('la cantidad debe ser mayor a cero', () => {
      expect(() => planDescuento([], '0')).to.throw(RangeError);
    });
  });
});

describe('Total de una entrada de mercancía', () => {
  it('suma cantidad por costo de cada renglón', () => {
    const { importes, total } = totalEntrada([
      { unidad: 'PIEZA', costo: '31.00', cantidad: '12' },
      { unidad: 'KG', costo: '22.40', cantidad: '2.5' },
    ]);
    expect(importes.map((i) => i.toFixed(2))).to.deep.equal(['372.00', '56.00']);
    expect(total.toFixed(2)).to.equal('428.00');
  });

  it('las piezas deben ser enteras', () => {
    expect(() => totalEntrada([{ unidad: 'PIEZA', costo: '10', cantidad: '1.5' }])).to.throw(
      RangeError,
      /enter/,
    );
  });

  it('necesita al menos un renglón', () => {
    expect(() => totalEntrada([])).to.throw(RangeError, /al menos un producto/);
  });
});

describe('Pago de una nota', () => {
  it('el pago es todo o nada: debe ser el total de la nota', () => {
    expect(revisarPagoNota('621', '621.00').toFixed(2)).to.equal('621.00');
    expect(() => revisarPagoNota('300.00', '621.00')).to.throw(
      RangeError,
      'El pago debe ser el total de la nota ($621.00)',
    );
    expect(() => revisarPagoNota('700', '621.00')).to.throw(RangeError, /total de la nota/);
  });
});

describe('Merma y consumo propio', () => {
  describe('lotePropuesto', () => {
    it('propone el lote con existencia que caduca primero', () => {
      const lotes = [
        lote('no-aplica', null, '5'),
        lote('diciembre', '2026-12-31', '3'),
        lote('noviembre', '2026-11-30', '2'),
      ];
      expect(lotePropuesto(lotes)!.id).to.equal('noviembre');
    });

    it('salta los lotes en cero o negativos', () => {
      const lotes = [
        lote('vacio', '2026-11-01', '0'),
        lote('negativo', '2026-11-15', '-2'),
        lote('ok', '2027-01-01', '4'),
      ];
      expect(lotePropuesto(lotes)!.id).to.equal('ok');
    });

    it('sin existencia no hay lote que proponer', () => {
      expect(lotePropuesto([lote('vacio', null, '0')])).to.equal(null);
      expect(lotePropuesto([])).to.equal(null);
    });
  });

  describe('revisarSalida', () => {
    it('acepta una cantidad que no supera la existencia del lote', () => {
      expect(revisarSalida('PIEZA', '5', '5').toFixed(2)).to.equal('5.00');
      expect(revisarSalida('KG', '2.50', '1.25').toFixed(2)).to.equal('1.25');
    });

    it('no deja sacar más de lo que hay en el lote', () => {
      expect(() => revisarSalida('PIEZA', '3', '4')).to.throw(RangeError, /existencia del lote/);
      expect(() => revisarSalida('KG', '-1', '0.5')).to.throw(RangeError, /existencia del lote/);
    });

    it('las piezas deben ser enteras y la cantidad mayor a cero', () => {
      expect(() => revisarSalida('PIEZA', '5', '1.5')).to.throw(RangeError, /enter/);
      expect(() => revisarSalida('KG', '5', '0')).to.throw(RangeError, /mayor a cero/);
    });
  });
});

describe('Ajuste por conteo', () => {
  /** Pasa los cambios a texto para compararlos fácil. */
  const ajuste = (lotes: LoteDisponible[], contada: string, unidad: 'PIEZA' | 'KG' = 'PIEZA') => {
    const r = planAjuste(unidad, lotes, contada);
    return {
      registrada: r.registrada.toFixed(2),
      diferencia: r.diferencia.toFixed(2),
      cambios: r.cambios.map((c) => [c.loteId, c.cantidad.toFixed(2)]),
      loteNuevo: r.loteNuevo?.toFixed(2) ?? null,
    };
  };

  it('si el conteo coincide, no hay cambios', () => {
    expect(ajuste([lote('a', '2026-11-30', '5')], '5')).to.deep.equal({
      registrada: '5.00',
      diferencia: '0.00',
      cambios: [],
      loteNuevo: null,
    });
  });

  it('el faltante se descuenta empezando por el lote que caduca primero', () => {
    const lotes = [lote('marzo', '2027-03-31', '10'), lote('noviembre', '2026-11-30', '5')];
    expect(ajuste(lotes, '8')).to.deep.include({
      diferencia: '-7.00',
      cambios: [
        ['noviembre', '-5.00'],
        ['marzo', '-2.00'],
      ],
    });
  });

  it('el sobrante se suma al lote más reciente', () => {
    const lotes = [
      lote('viejo', '2026-11-30', '5', '2026-10-01'),
      lote('nuevo', '2027-03-31', '2', '2026-10-15'),
    ];
    expect(ajuste(lotes, '10')).to.deep.include({ diferencia: '3.00', cambios: [['nuevo', '3.00']] });
  });

  it('los lotes negativos de una venta sin existencias quedan en cero', () => {
    const lotes = [lote('a', '2026-11-30', '5', '2026-10-01'), lote('b', null, '-2', '2026-10-10')];
    // Había 3 y se contó 1: el lote b sube a 0 y del lote a salen 4.
    expect(ajuste(lotes, '1')).to.deep.include({
      registrada: '3.00',
      diferencia: '-2.00',
      cambios: [
        ['b', '2.00'],
        ['a', '-4.00'],
      ],
    });
  });

  it('si el lote negativo es el más reciente y sobra, recibe todo en un solo cambio', () => {
    const lotes = [lote('a', '2026-11-30', '1', '2026-10-01'), lote('b', null, '-3', '2026-10-10')];
    expect(ajuste(lotes, '4')).to.deep.include({ diferencia: '6.00', cambios: [['b', '6.00']] });
  });

  it('sin lotes, lo contado va a un lote nuevo', () => {
    expect(ajuste([], '2.5', 'KG')).to.deep.include({ cambios: [], loteNuevo: '2.50' });
  });

  it('lo contado no puede ser negativo y las piezas deben ser enteras', () => {
    expect(() => planAjuste('PIEZA', [], '-1')).to.throw(RangeError, /negativ/);
    expect(() => planAjuste('PIEZA', [], '1.5')).to.throw(RangeError, /enter/);
  });
});

describe('Alertas de inventario', () => {
  const HOY = '2026-10-17';

  describe('diasParaCaducar', () => {
    it('cuenta los días del calendario; negativo si ya caducó', () => {
      expect(diasParaCaducar('2026-10-24', HOY)).to.equal(7);
      expect(diasParaCaducar(HOY, HOY)).to.equal(0);
      expect(diasParaCaducar('2026-10-15', HOY)).to.equal(-2);
      expect(diasParaCaducar('2026-11-01', HOY)).to.equal(15);
    });

    it('no se confunde con el cambio de horario ni de año', () => {
      expect(diasParaCaducar('2027-01-03', '2026-12-30')).to.equal(4);
      expect(diasParaCaducar('2026-04-06', '2026-04-03')).to.equal(3);
    });
  });

  describe('caducaPronto', () => {
    it('alerta si caduca en 7 días o menos, incluidos los ya caducados', () => {
      expect(caducaPronto(lote('a', '2026-10-24', '3'), HOY)).to.equal(true);
      expect(caducaPronto(lote('b', '2026-10-10', '3'), HOY)).to.equal(true);
      expect(caducaPronto(lote('c', '2026-10-25', '3'), HOY)).to.equal(false);
    });

    it('"No aplica" nunca alerta, ni un lote sin existencia', () => {
      expect(caducaPronto(lote('d', null, '3'), HOY)).to.equal(false);
      expect(caducaPronto(lote('e', '2026-10-18', '0'), HOY)).to.equal(false);
      expect(caducaPronto(lote('f', '2026-10-18', '-1'), HOY)).to.equal(false);
    });
  });

  describe('resumenCaducidad', () => {
    it('cuenta los lotes por caducar y los ya caducados; los demás no cuentan', () => {
      const lotes = [
        lote('a', '2026-10-24', '3'), // en 7 días
        lote('b', HOY, '1'), // hoy todavía no caduca
        lote('c', '2026-10-10', '2'), // ya caducó
        lote('d', null, '5'), // "No aplica"
        lote('e', '2026-10-18', '0'), // sin existencia
        lote('f', '2026-11-30', '4'), // lejos
      ];
      expect(resumenCaducidad(lotes, HOY)).to.deep.equal({ porCaducar: 2, caducados: 1 });
    });

    it('sin lotes con caducidad, todo en cero', () => {
      expect(resumenCaducidad([], HOY)).to.deep.equal({ porCaducar: 0, caducados: 0 });
    });
  });

  describe('revisionPendiente', () => {
    it('está pendiente si ya pasó la hora y hoy no se ha hecho', () => {
      expect(revisionPendiente(null, HOY, '06:00', '06:00')).to.equal(true);
      expect(revisionPendiente('2026-10-16', HOY, '09:30', '06:00')).to.equal(true);
    });

    it('no está pendiente antes de la hora ni si ya se hizo hoy', () => {
      expect(revisionPendiente('2026-10-16', HOY, '05:59', '06:00')).to.equal(false);
      expect(revisionPendiente(HOY, HOY, '09:30', '06:00')).to.equal(false);
    });
  });

  describe('fraseDeAlertas', () => {
    it('sin alertas lo dice', () => {
      expect(fraseDeAlertas({ minimo: 0, porCaducar: 0, caducados: 0 })).to.equal(
        'Sin alertas de inventario',
      );
    });

    it('nombra solo lo que hay, en singular o plural', () => {
      expect(fraseDeAlertas({ minimo: 1, porCaducar: 0, caducados: 0 })).to.equal(
        '1 producto en existencia mínima',
      );
      expect(fraseDeAlertas({ minimo: 0, porCaducar: 2, caducados: 1 })).to.equal(
        '2 lotes por caducar y 1 lote caducado',
      );
      expect(fraseDeAlertas({ minimo: 3, porCaducar: 1, caducados: 2 })).to.equal(
        '3 productos en existencia mínima, 1 lote por caducar y 2 lotes caducados',
      );
    });
  });

  describe('enExistenciaMinima', () => {
    it('alerta si la existencia es igual o menor a la mínima', () => {
      expect(enExistenciaMinima('5', '5')).to.equal(true);
      expect(enExistenciaMinima('-1', '0')).to.equal(true);
      expect(enExistenciaMinima('5.01', '5')).to.equal(false);
    });
  });
});
