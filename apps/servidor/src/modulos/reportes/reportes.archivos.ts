/**
 * Archivos de los reportes: el mismo reporte de la consulta se pasa a tablas y se dibuja en PDF
 * (pdfkit, hoja carta acostada) o en Excel (exceljs, una hoja por tabla). Así el archivo trae
 * exactamente lo mismo que se ve en pantalla.
 */
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { formatoMoneda, type FormatoExportacion, type Reporte, type TipoReporte } from '@pos/compartido';
import { ZONA_HORARIA } from '../../comun/fechas';

type TipoColumna = 'texto' | 'dinero' | 'cantidad' | 'entero' | 'porcentaje';
type Celda = string | number | null;

interface Columna {
  titulo: string;
  tipo: TipoColumna;
  ancho: number; // en caracteres; en el PDF se reparte en proporción
}

/** Una tabla del reporte; los montos y cantidades llegan como texto decimal. */
export interface Tabla {
  titulo: string;
  columnas: Columna[];
  filas: Celda[][];
  totales: Celda[][];
}

export const TITULOS: Record<TipoReporte, string> = {
  ventas: 'Ventas por día',
  ganancia: 'Ganancia por producto',
  'mas-vendidos': 'Más y menos vendidos',
  cortes: 'Cortes de caja',
  inventario: 'Inventario valorizado',
  mermas: 'Mermas y consumo',
  cancelaciones: 'Cancelaciones y devoluciones',
  empleados: 'Ventas por empleado',
};

// --- Del reporte a tablas ---

const col = (titulo: string, tipo: TipoColumna, ancho = tipo === 'texto' ? 24 : 12): Columna => ({
  titulo,
  tipo,
  ancho,
});

const formatoFechaHora = new Intl.DateTimeFormat('es-MX', {
  timeZone: ZONA_HORARIA,
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** "2026-10-17" → "17/10/2026" */
const dia = (fecha: string) => fecha.split('-').reverse().join('/');

/** Instante ISO → "17/10/2026 14:30" en la hora de la tienda. */
function fechaHora(iso: string | Date): string {
  const p = Object.fromEntries(formatoFechaHora.formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}`;
}

const MOTIVOS_CANCELACION = { EN_CURSO: 'En pantalla', CIERRE: 'Al cerrar la caja' };
const REEMBOLSOS = { EFECTIVO: 'Efectivo', SALDO_FAVOR: 'Saldo a favor' };
const TIPOS_SALIDA = { MERMA: 'Merma', CONSUMO: 'Consumo' };
const UNIDADES = { PIEZA: 'Pieza', KG: 'Kg' };

export function tablasDeReporte(r: Reporte): Tabla[] {
  switch (r.tipo) {
    case 'ventas': {
      const cifras = (c: typeof r.totales) => [
        c.ventas,
        c.total,
        c.efectivo,
        c.tarjeta,
        c.transferencia,
        c.saldoFavor,
        c.devuelto,
        c.neto,
      ];
      return [
        {
          titulo: TITULOS.ventas,
          columnas: [
            col('Fecha', 'texto', 12),
            col('Ventas', 'entero', 8),
            col('Total', 'dinero'),
            col('Efectivo', 'dinero'),
            col('Tarjeta', 'dinero'),
            col('Transferencia', 'dinero'),
            col('Saldo a favor', 'dinero'),
            col('Devuelto', 'dinero'),
            col('Neto', 'dinero'),
          ],
          filas: r.dias.map((d) => [dia(d.fecha), ...cifras(d)]),
          totales: [['Total', ...cifras(r.totales)]],
        },
      ];
    }
    case 'ganancia':
      return [
        {
          titulo: TITULOS.ganancia,
          columnas: [
            col('Producto', 'texto', 30),
            col('Unidad', 'texto', 8),
            col('Cantidad', 'cantidad', 10),
            col('Venta', 'dinero'),
            col('Costo', 'dinero'),
            col('Ganancia', 'dinero'),
            col('Margen', 'porcentaje', 9),
          ],
          filas: r.productos.map((p) => [
            p.nombre,
            UNIDADES[p.unidad],
            p.cantidad,
            p.venta,
            p.costo,
            p.ganancia,
            p.margen,
          ]),
          totales: [
            ['Total', null, null, r.totales.venta, r.totales.costo, r.totales.ganancia, r.totales.margen],
          ],
        },
      ];
    case 'mas-vendidos': {
      const columnas = [
        col('Producto', 'texto', 30),
        col('Unidad', 'texto', 8),
        col('Cantidad', 'cantidad', 10),
        col('Venta', 'dinero'),
      ];
      const filas = (lista: typeof r.masVendidos) =>
        lista.map((v) => [v.nombre, UNIDADES[v.unidad], v.cantidad, v.venta]);
      return [
        { titulo: 'Más vendidos', columnas, filas: filas(r.masVendidos), totales: [] },
        { titulo: 'Menos vendidos', columnas, filas: filas(r.menosVendidos), totales: [] },
      ];
    }
    case 'cortes':
      return [
        {
          titulo: TITULOS.cortes,
          columnas: [
            col('Fecha', 'texto', 12),
            col('Estado', 'texto', 9),
            col('Abrió', 'texto', 16),
            col('Cerró', 'texto', 16),
            col('Fondo', 'dinero'),
            col('Esperado', 'dinero'),
            col('Contado', 'dinero'),
            col('Diferencia', 'dinero'),
            col('Justificación', 'texto', 30),
          ],
          filas: r.cajas.map((c) => [
            dia(c.fecha),
            c.estado === 'ABIERTA' ? 'Abierta' : 'Cerrada',
            c.abiertaPor,
            c.cerradaPor,
            c.fondoInicial,
            c.esperado,
            c.contado,
            c.diferencia,
            c.justificacion,
          ]),
          totales: [
            [`${r.totales.cajas} cajas`, null, null, null, null, null, null, r.totales.diferencia, null],
          ],
        },
      ];
    case 'inventario':
      return [
        {
          titulo: TITULOS.inventario,
          columnas: [
            col('Producto', 'texto', 34),
            col('Unidad', 'texto', 8),
            col('Existencia', 'cantidad', 11),
            col('Valor', 'dinero', 14),
          ],
          filas: r.productos.map((p) => [p.nombre, UNIDADES[p.unidad], p.existencia, p.valor]),
          totales: [[`${r.totales.productos} productos`, null, null, r.totales.valor]],
        },
      ];
    case 'mermas': {
      const total = (tipo: 'merma' | 'consumo', nombre: string) => [
        `${nombre}: ${r.totales[tipo].registros}`,
        null,
        null,
        null,
        r.totales[tipo].costo,
        null,
        null,
        null,
      ];
      return [
        {
          titulo: TITULOS.mermas,
          columnas: [
            col('Fecha', 'texto', 16),
            col('Tipo', 'texto', 9),
            col('Producto', 'texto', 26),
            col('Cantidad', 'cantidad', 10),
            col('Costo', 'dinero'),
            col('Motivo', 'texto', 20),
            col('Comentario', 'texto', 20),
            col('Usuario', 'texto', 16),
          ],
          filas: r.salidas.map((s) => [
            fechaHora(s.fecha),
            TIPOS_SALIDA[s.tipo],
            s.nombre,
            s.cantidad,
            s.costo,
            s.motivo,
            s.comentario,
            s.usuario,
          ]),
          totales: [total('merma', 'Mermas'), total('consumo', 'Consumo')],
        },
      ];
    }
    case 'cancelaciones':
      return [
        {
          titulo: 'Ventas canceladas',
          columnas: [
            col('Fecha', 'texto', 16),
            col('Motivo', 'texto', 18),
            col('Canceló', 'texto', 18),
            col('Renglones', 'entero', 10),
            col('Total', 'dinero'),
          ],
          filas: r.canceladas.map((c) => [
            fechaHora(c.fecha),
            MOTIVOS_CANCELACION[c.motivo],
            c.canceladaPor ?? 'Sistema',
            c.renglones,
            c.total,
          ]),
          totales: [[`${r.totales.canceladas} canceladas`, null, null, null, r.totales.totalCancelado]],
        },
        {
          titulo: 'Devoluciones',
          columnas: [
            col('Fecha', 'texto', 16),
            col('Folio', 'entero', 8),
            col('Tipo', 'texto', 9),
            col('Motivo', 'texto', 26),
            col('Reembolso', 'texto', 14),
            col('Importe', 'dinero'),
            col('Registró', 'texto', 18),
          ],
          filas: r.devoluciones.map((d) => [
            fechaHora(d.fecha),
            d.folio,
            d.tipo === 'TOTAL' ? 'Total' : 'Parcial',
            d.motivo,
            REEMBOLSOS[d.formaReembolso],
            d.importe,
            d.usuario,
          ]),
          totales: [
            [`${r.totales.devoluciones} devoluciones`, null, null, null, null, r.totales.totalDevuelto, null],
          ],
        },
      ];
    case 'empleados':
      return [
        {
          titulo: TITULOS.empleados,
          columnas: [
            col('Empleado', 'texto', 26),
            col('Ventas', 'entero', 8),
            col('Total', 'dinero'),
            col('Cancelaciones', 'entero', 13),
            col('Devoluciones', 'entero', 12),
            col('Devuelto', 'dinero'),
          ],
          filas: r.empleados.map((e) => [
            e.nombre,
            e.ventas,
            e.total,
            e.cancelaciones,
            e.devoluciones,
            e.devuelto,
          ]),
          totales: [],
        },
      ];
  }
}

// --- Encabezado común ---

export interface DatosArchivo {
  tienda: string;
  generadoEn: Date;
}

function periodoTexto(r: Reporte): string {
  if (r.tipo === 'inventario') return `Al ${dia(r.hasta)}`;
  return r.desde === r.hasta ? `Día ${dia(r.desde)}` : `Del ${dia(r.desde)} al ${dia(r.hasta)}`;
}

/** Texto de una celda para el PDF. */
function textoCelda(valor: Celda, tipo: TipoColumna): string {
  if (valor === null) return '';
  if (tipo === 'dinero') return formatoMoneda(valor);
  if (tipo === 'porcentaje') return `${valor} %`;
  return String(valor);
}

// --- PDF ---

const MARGEN = 36; // media pulgada
const ALTO_RENGLON = 18;

export async function generarPdf(reporte: Reporte, datos: DatosArchivo): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'LETTER', layout: 'landscape', margin: MARGEN, bufferPages: true });
  const partes: Buffer[] = [];
  doc.on('data', (parte: Buffer) => partes.push(parte));
  const terminado = new Promise<Buffer>((listo) => doc.on('end', () => listo(Buffer.concat(partes))));

  const ancho = doc.page.width - 2 * MARGEN;
  const limite = () => doc.page.height - MARGEN - 20; // deja lugar al número de página

  doc.font('Helvetica-Bold').fontSize(14).text(datos.tienda);
  doc.fontSize(12).text(TITULOS[reporte.tipo]);
  doc
    .font('Helvetica')
    .fontSize(9)
    .text(`${periodoTexto(reporte)}   ·   Generado el ${fechaHora(datos.generadoEn)}`);
  doc.moveDown();

  const tablas = tablasDeReporte(reporte);
  for (const tabla of tablas) {
    const total = tabla.columnas.reduce((t, c) => t + c.ancho, 0);
    const anchos = tabla.columnas.map((c) => (c.ancho / total) * ancho);

    const renglon = (celdas: Celda[], estilo: 'encabezado' | 'dato' | 'total') => {
      if (doc.y + ALTO_RENGLON > limite()) {
        doc.addPage();
        if (estilo !== 'encabezado')
          renglon(
            tabla.columnas.map((c) => c.titulo),
            'encabezado',
          );
      }
      const y = doc.y;
      if (estilo === 'encabezado') doc.rect(MARGEN, y, ancho, ALTO_RENGLON).fill('#e6e6e6');
      if (estilo === 'total')
        doc
          .moveTo(MARGEN, y)
          .lineTo(MARGEN + ancho, y)
          .stroke('#555555');
      doc
        .fillColor('black')
        .font(estilo === 'dato' ? 'Helvetica' : 'Helvetica-Bold')
        .fontSize(8);
      let x = MARGEN;
      celdas.forEach((valor, i) => {
        const columna = tabla.columnas[i]!;
        const texto = estilo === 'encabezado' ? String(valor) : textoCelda(valor, columna.tipo);
        // Un solo renglón por celda: lo que no quepa se corta con "…".
        doc.text(texto, x + 3, y + 5, {
          width: anchos[i]! - 6,
          height: 9,
          align: columna.tipo === 'texto' ? 'left' : 'right',
          ellipsis: true,
        });
        x += anchos[i]!;
      });
      doc.x = MARGEN;
      doc.y = y + ALTO_RENGLON;
    };

    if (doc.y + 3 * ALTO_RENGLON > limite()) doc.addPage();
    // Si solo hay una tabla, su título es el del reporte y ya está arriba.
    if (tablas.length > 1) {
      doc.font('Helvetica-Bold').fontSize(10).text(tabla.titulo, MARGEN, doc.y);
      doc.moveDown(0.3);
    }
    renglon(
      tabla.columnas.map((c) => c.titulo),
      'encabezado',
    );
    if (tabla.filas.length === 0) {
      doc
        .font('Helvetica-Oblique')
        .fontSize(8)
        .text('Sin datos en el periodo', MARGEN + 3, doc.y + 5);
      doc.y += ALTO_RENGLON - 5;
    }
    for (const fila of tabla.filas) renglon(fila, 'dato');
    for (const fila of tabla.totales) renglon(fila, 'total');
    doc.moveDown();
  }

  // Número de página al pie de cada hoja.
  const { start, count } = doc.bufferedPageRange();
  for (let i = start; i < start + count; i++) {
    doc.switchToPage(i);
    doc
      .font('Helvetica')
      .fontSize(8)
      .text(`Página ${i - start + 1} de ${count}`, MARGEN, doc.page.height - MARGEN - 10, {
        width: ancho,
        align: 'right',
        lineBreak: false,
      });
  }
  doc.end();
  return terminado;
}

// --- Excel ---

const FORMATOS_EXCEL: Partial<Record<TipoColumna, string>> = {
  dinero: '"$"#,##0.00;-"$"#,##0.00',
  cantidad: '#,##0.00',
  porcentaje: '0.0%',
};

/** Valor de una celda para Excel: los montos y cantidades como número. */
function valorExcel(valor: Celda, tipo: TipoColumna): Celda {
  if (valor === null || typeof valor === 'number') return valor;
  if (tipo === 'dinero' || tipo === 'cantidad') return Number(valor);
  if (tipo === 'porcentaje') return Number(valor) / 100;
  return valor;
}

/** Excel no acepta algunos caracteres en el nombre de la hoja, ni más de 31. */
const nombreHoja = (titulo: string) => titulo.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31);

export async function generarExcel(reporte: Reporte, datos: DatosArchivo): Promise<Buffer> {
  const libro = new ExcelJS.Workbook();
  libro.creator = datos.tienda;
  libro.created = datos.generadoEn;

  for (const tabla of tablasDeReporte(reporte)) {
    const hoja = libro.addWorksheet(nombreHoja(tabla.titulo));
    hoja.addRow([`${TITULOS[reporte.tipo]} · ${datos.tienda}`]).font = { bold: true, size: 14 };
    hoja.addRow([`${periodoTexto(reporte)} · Generado el ${fechaHora(datos.generadoEn)}`]);
    hoja.addRow([]);

    const encabezado = hoja.addRow(tabla.columnas.map((c) => c.titulo));
    encabezado.font = { bold: true };
    encabezado.eachCell((celda) => {
      celda.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE6E6E6' } };
    });
    hoja.views = [{ state: 'frozen', ySplit: encabezado.number }]; // el encabezado no se pierde al bajar

    const agregar = (fila: Celda[]) =>
      hoja.addRow(fila.map((v, i) => valorExcel(v, tabla.columnas[i]!.tipo)));
    if (tabla.filas.length === 0) hoja.addRow(['Sin datos en el periodo']).font = { italic: true };
    for (const fila of tabla.filas) agregar(fila);
    for (const fila of tabla.totales) agregar(fila).font = { bold: true };

    tabla.columnas.forEach((c, i) => {
      const columna = hoja.getColumn(i + 1);
      columna.width = c.ancho + 2;
      const formato = FORMATOS_EXCEL[c.tipo];
      if (formato) columna.numFmt = formato;
    });
  }
  return Buffer.from(await libro.xlsx.writeBuffer());
}

/** Genera el archivo en el formato pedido. */
export function generarArchivoReporte(
  reporte: Reporte,
  formato: FormatoExportacion,
  datos: DatosArchivo,
): Promise<Buffer> {
  return formato === 'PDF' ? generarPdf(reporte, datos) : generarExcel(reporte, datos);
}
