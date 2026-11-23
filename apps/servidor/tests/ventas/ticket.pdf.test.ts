import { expect } from 'chai';
import { generarTicketPdf, type DatosTicket } from '../../src/modulos/ventas/ventas.ticket';

/** Texto de un PDF de pdfkit sin comprimir: une los fragmentos hexadecimales de cada operador TJ. */
function textoDe(pdf: Buffer): string {
  const contenido = pdf.toString('latin1');
  return (
    [...contenido.matchAll(/\[((?:<[0-9a-f]*>\s*-?[\d.]*\s*)+)\]\s*TJ/g)]
      .map((m) =>
        [...m[1]!.matchAll(/<([0-9a-f]*)>/g)]
          .map((h) => Buffer.from(h[1]!, 'hex').toString('latin1'))
          .join(''),
      )
      // Con espacio, un texto que pdfkit partió en dos renglones se sigue encontrando completo.
      .join(' ')
  );
}

function anchoYAlto(pdf: Buffer): [number, number] {
  const m = pdf.toString('latin1').match(/\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/)!;
  return [Number(m[1]), Number(m[2])];
}

const datos: DatosTicket = {
  tienda: {
    nombre: 'Abarrotes Doña Mary',
    direccion: 'Calle Ángel Flores 123, Culiacán',
    telefono: '667 123 4567',
    politicaDevolucion: 'Devoluciones el mismo día presentando este ticket.',
  },
  folio: 128,
  fecha: new Date('2026-10-18T02:15:00Z'), // 17/10/2026 19:15 en Mazatlán
  cajero: 'Dueño',
  renglones: [
    {
      nombre: 'Frijol negro 1 kg',
      cantidad: '2',
      unidad: 'PIEZA',
      precio: '38.50',
      importe: '77.00',
      descuento: '0.00',
    },
    {
      nombre: 'Queso panela',
      cantidad: '0.75',
      unidad: 'KG',
      precio: '120.00',
      importe: '90.00',
      descuento: '0.00',
    },
    {
      nombre: 'Refresco 600 ml',
      cantidad: '2',
      unidad: 'PIEZA',
      precio: '18.00',
      importe: '36.00',
      descuento: '18.00',
    },
  ],
  descuentoManual: '0.00',
  total: '185.00',
  redondeo: '0.00',
  pagos: [
    { metodo: 'TARJETA', monto: '100.00', referencia: 'A-7781' },
    { metodo: 'EFECTIVO', monto: '100.00' },
  ],
  cambio: '15.00',
  ahorroPromociones: '18.00',
  enlaceBot: 'https://t.me/abarrotes_mary_bot?start=t128',
  copia: false,
};

describe('Ticket PDF de 80 mm', () => {
  it('es un PDF de 80 mm de ancho, el rollo de la futura impresora', async () => {
    const pdf = await generarTicketPdf(datos, { comprimir: false });
    expect(pdf.subarray(0, 5).toString()).to.equal('%PDF-');
    const [ancho] = anchoYAlto(pdf);
    expect(ancho).to.be.closeTo((80 / 25.4) * 72, 0.01);
  });

  it('contiene todos los elementos del ticket', async () => {
    const texto = textoDe(await generarTicketPdf(datos, { comprimir: false }));
    for (const esperado of [
      'Abarrotes Doña Mary',
      'Calle Ángel Flores 123, Culiacán',
      'Folio 128',
      '17/10/2026 19:15',
      'Cajero: Dueño',
      'Frijol negro 1 kg',
      '0.75 kg x $120.00',
      'TOTAL',
      '$185.00',
      'Tarjeta (ref. A-7781)',
      'Efectivo',
      'Cambio',
      '$15.00',
      'Ahorro en promociones',
      'Devoluciones el mismo día presentando este ticket.',
      'https://t.me/abarrotes_mary_bot?start=t128',
    ]) {
      expect(texto, esperado).to.include(esperado);
    }
    expect(texto).to.not.include('COPIA');
  });

  it('incluye el código QR del bot como imagen', async () => {
    const pdf = await generarTicketPdf(datos, { comprimir: false });
    expect(pdf.toString('latin1')).to.match(/\/Subtype \/Image/);
  });

  it('la reimpresión muestra los mismos datos con la leyenda de copia', async () => {
    const texto = textoDe(await generarTicketPdf({ ...datos, copia: true }, { comprimir: false }));
    expect(texto).to.include('COPIA');
    expect(texto).to.include('Folio 128');
  });

  it('muestra el redondeo del efectivo cuando lo hay', async () => {
    const texto = textoDe(await generarTicketPdf({ ...datos, redondeo: '0.20' }, { comprimir: false }));
    expect(texto).to.include('Redondeo');
    expect(texto).to.include('$0.20');
  });

  it('el largo del ticket crece con los productos', async () => {
    const corto = anchoYAlto(await generarTicketPdf(datos))[1];
    const muchos = { ...datos, renglones: [...datos.renglones, ...datos.renglones, ...datos.renglones] };
    const largo = anchoYAlto(await generarTicketPdf(muchos))[1];
    expect(largo).to.be.greaterThan(corto);
  });
});
