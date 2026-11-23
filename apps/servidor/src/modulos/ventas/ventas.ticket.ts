/**
 * Ticket en PDF de 80 mm, mientras no hay impresora. Se dibuja con pdfkit y el QR del bot de Telegram
 * con qrcode. Los datos los prepara ventas.ts (datosTicket).
 */
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import { Decimal, formatoMoneda, type MetodoPagoGuardado, type Unidad } from '@pos/compartido';
import { ZONA_HORARIA } from '../../comun/fechas';

/** Datos del ticket; los montos llegan como texto. */
export interface DatosTicket {
  tienda: { nombre: string; direccion?: string; telefono?: string; politicaDevolucion: string };
  folio: number;
  fecha: Date;
  cajero: string;
  renglones: {
    nombre: string;
    cantidad: string;
    unidad: Unidad;
    precio: string;
    importe: string;
    descuento: string; // por promoción
  }[];
  descuentoManual: string;
  total: string;
  redondeo: string; // redondeo del efectivo
  pagos: { metodo: MetodoPagoGuardado; monto: string; referencia?: string }[];
  cambio: string;
  ahorroPromociones: string;
  enlaceBot?: string; // también se imprime como QR
  copia: boolean; // reimpresión: sale marcado "*** COPIA ***"
}

// Medidas: pdfkit usa puntos (72 por pulgada); mm() convierte milímetros a puntos.
const mm = (valor: number) => (valor / 25.4) * 72;
const ANCHO = mm(80);
const MARGEN = mm(4);
const UTIL = ANCHO - 2 * MARGEN;

const METODOS: Record<MetodoPagoGuardado, string> = {
  EFECTIVO: 'Efectivo',
  TARJETA: 'Tarjeta',
  TRANSFERENCIA: 'Transferencia',
  SALDO_FAVOR: 'Saldo a favor',
};

// Fecha en la hora de la tienda, por ejemplo "17/10/2026 14:30".
const formatoFecha = new Intl.DateTimeFormat('es-MX', {
  timeZone: ZONA_HORARIA,
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function fechaTicket(fecha: Date): string {
  const p = Object.fromEntries(formatoFecha.formatToParts(fecha).map((x) => [x.type, x.value]));
  return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}`;
}

/** Para no imprimir renglones en $0.00. */
const positivo = (monto: string) => new Decimal(monto).gt(0);

/**
 * Genera el PDF como Buffer. No se sabe de antemano qué tan largo va a salir, así que se dibuja dos
 * veces: una en una hoja grande para medir y otra con el largo exacto, como un rollo térmico.
 */
export async function generarTicketPdf(
  datos: DatosTicket,
  opciones: { comprimir?: boolean } = {},
): Promise<Buffer> {
  const qr = datos.enlaceBot
    ? await QRCode.toBuffer(datos.enlaceBot, {
        type: 'png',
        margin: 1,
        width: 240,
        errorCorrectionLevel: 'M',
      })
    : null;

  const medida = new PDFDocument({ size: [ANCHO, 10_000], margin: MARGEN, compress: false });
  const alto = dibujar(medida, datos, qr) + MARGEN * 2;
  medida.end();

  const doc = new PDFDocument({
    size: [ANCHO, alto],
    margin: MARGEN,
    compress: opciones.comprimir ?? true,
    info: { Title: `Ticket ${datos.folio}${datos.copia ? ' (copia)' : ''}`, Author: datos.tienda.nombre },
  });

  // pdfkit entrega el archivo en pedazos; se juntan en un Buffer al terminar.
  const partes: Buffer[] = [];
  doc.on('data', (parte: Buffer) => partes.push(parte));
  const terminado = new Promise<Buffer>((resolver, rechazar) => {
    doc.on('end', () => resolver(Buffer.concat(partes)));
    doc.on('error', rechazar);
  });
  dibujar(doc, datos, qr);
  doc.end();
  return terminado;
}

/** Dibuja el ticket y regresa dónde quedó verticalmente. */
function dibujar(doc: PDFKit.PDFDocument, d: DatosTicket, qr: Buffer | null): number {
  // Ayudantes: texto centrado, fila con texto y monto, y línea punteada.
  const centrado = (texto: string, tamano: number, negrita = false) => {
    doc.font(negrita ? 'Helvetica-Bold' : 'Helvetica').fontSize(tamano);
    doc.text(texto, MARGEN, doc.y, { width: UTIL, align: 'center' });
  };
  const fila = (izquierda: string, derecha: string, tamano = 8, negrita = false) => {
    doc.font(negrita ? 'Helvetica-Bold' : 'Helvetica').fontSize(tamano);
    const y = doc.y;
    doc.text(izquierda, MARGEN, y, { width: UTIL * 0.68 });
    const abajo = doc.y;
    doc.text(derecha, MARGEN, y, { width: UTIL, align: 'right' });
    doc.y = Math.max(abajo, doc.y);
  };
  const separador = () => {
    doc.moveDown(0.3);
    doc
      .moveTo(MARGEN, doc.y)
      .lineTo(ANCHO - MARGEN, doc.y)
      .dash(1.5, { space: 1.5 })
      .lineWidth(0.5)
      .stroke()
      .undash();
    doc.moveDown(0.4);
  };

  // Encabezado: tienda, folio, fecha y cajero.
  if (d.copia) centrado('*** COPIA ***', 10, true);
  centrado(d.tienda.nombre, 11, true);
  if (d.tienda.direccion) centrado(d.tienda.direccion, 7);
  if (d.tienda.telefono) centrado(`Tel. ${d.tienda.telefono}`, 7);
  separador();
  fila(`Folio ${d.folio}`, fechaTicket(d.fecha));
  fila(`Cajero: ${d.cajero}`, '');
  separador();

  // Productos: nombre y, debajo, cantidad x precio e importe.
  for (const r of d.renglones) {
    doc.font('Helvetica').fontSize(8).text(r.nombre, MARGEN, doc.y, { width: UTIL });
    const cantidad = r.unidad === 'KG' ? `${new Decimal(r.cantidad).toFixed(2)} kg` : `${r.cantidad} pza`;
    fila(`   ${cantidad} x ${formatoMoneda(r.precio)}`, formatoMoneda(r.importe), 7.5);
    if (positivo(r.descuento)) fila('   Promoción', `-${formatoMoneda(r.descuento)}`, 7.5);
  }
  separador();

  // Totales y pagos.
  if (positivo(d.descuentoManual)) fila('Descuento', `-${formatoMoneda(d.descuentoManual)}`);
  fila('TOTAL', formatoMoneda(d.total), 11, true);
  if (positivo(d.redondeo)) fila('Redondeo del efectivo', formatoMoneda(d.redondeo));
  doc.moveDown(0.3);
  for (const p of d.pagos) {
    // El saldo a favor no enseña su referencia (es un id interno).
    const conReferencia = p.referencia && p.metodo !== 'SALDO_FAVOR';
    const metodo = conReferencia ? `${METODOS[p.metodo]} (ref. ${p.referencia})` : METODOS[p.metodo];
    fila(metodo, formatoMoneda(p.monto));
  }
  fila('Cambio', formatoMoneda(d.cambio), 9, true);
  if (positivo(d.ahorroPromociones)) fila('Ahorro en promociones', formatoMoneda(d.ahorroPromociones));
  separador();

  // Pie: política de devolución, QR del bot y despedida.
  centrado(d.tienda.politicaDevolucion, 7);
  if (qr && d.enlaceBot) {
    doc.moveDown(0.5);
    centrado('Reciba nuestras promociones en Telegram:', 7);
    const lado = mm(28);
    doc.image(qr, (ANCHO - lado) / 2, doc.y + 2, { width: lado, height: lado });
    doc.y += lado + 4;
    centrado(d.enlaceBot, 6);
  }
  doc.moveDown(0.5);
  centrado('Gracias por su compra', 8, true);
  if (d.copia) centrado('*** COPIA ***', 10, true);
  return doc.y;
}
