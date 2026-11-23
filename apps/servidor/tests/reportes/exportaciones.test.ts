import { expect } from 'chai';
import ExcelJS from 'exceljs';
import { existsSync } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import sinon from 'sinon';
import { TIPOS_REPORTE } from '@pos/compartido';
import { fuenteDatos } from '../../src/infraestructura/base-datos/fuente';
import * as archivos from '../../src/modulos/reportes/reportes.archivos';
import { ExportacionesServicio } from '../../src/modulos/reportes/reportes';
import { AHORA, appDePrueba, fijarHora, productoValido, type Api } from '../ayuda';

const carpeta = process.env.REPORTES_DIR!;

/** Un producto con 2 piezas en inventario, para que el reporte tenga datos. */
async function conInventario(api: Api) {
  const [categoria] = await fuenteDatos.query(`SELECT id FROM categoria WHERE nombre = 'Abarrotes'`);
  const producto = await api
    .post('/api/v1/productos')
    .send({ ...productoValido, categoriaId: categoria.id })
    .expect(201);
  const proveedor = await api.post('/api/v1/proveedores').send({ nombre: 'La Costeña' }).expect(201);
  await api
    .post('/api/v1/inventario/entradas')
    .send({
      proveedorId: proveedor.body.data.id,
      folioNota: 'N-1',
      renglones: [{ productoId: producto.body.data.id, cantidad: '2', costoUnitario: '30', caducidad: null }],
    })
    .expect(201);
}

const pedir = (api: Api, tipo: string, cuerpo: object) =>
  api.post(`/api/v1/reportes/${tipo}/exportaciones`).send(cuerpo);

describe('Exportación de reportes a PDF y Excel', () => {
  beforeEach(() => rm(carpeta, { recursive: true, force: true }));
  afterEach(() => sinon.restore());

  it('el pedido queda PENDIENTE para el worker y no bloquea (paso 1)', async () => {
    const { api } = await appDePrueba();
    const res = await pedir(api, 'ventas', { formato: 'PDF', desde: '2026-10-01' }).expect(202);
    expect(res.body.message).to.include('se avisará');
    expect(res.body.data).to.include({
      tipo: 'ventas',
      formato: 'PDF',
      desde: '2026-10-01',
      hasta: '2026-10-17',
      estado: 'PENDIENTE',
      disponible: false,
    });
    expect(res.body.data.archivo).to.match(/^reporte-ventas_2026-10-01_2026-10-17_[0-9a-f]{8}\.pdf$/);
  });

  it('genera el PDF y se descarga (pasos 2 y 3)', async () => {
    const { api } = await appDePrueba();
    await conInventario(api);
    const { body } = await pedir(api, 'inventario', { formato: 'PDF' }).expect(202);
    const exportacion = await new ExportacionesServicio().generar(body.data.id);
    expect(exportacion.estado).to.equal('LISTO');

    const res = await api
      .get(`/api/v1/reportes/archivos/${body.data.id}`)
      .buffer(true)
      .parse((r, listo) => {
        const partes: Buffer[] = [];
        r.on('data', (p: Buffer) => partes.push(p));
        r.on('end', () => listo(null, Buffer.concat(partes)));
      })
      .expect(200);
    expect(res.headers['content-type']).to.include('application/pdf');
    expect(res.headers['content-disposition']).to.include(body.data.archivo);
    expect((res.body as Buffer).subarray(0, 5).toString()).to.equal('%PDF-');
    expect(Number(exportacion.bytes)).to.equal((res.body as Buffer).length);
  });

  it('el Excel trae los mismos datos que el reporte en pantalla', async () => {
    const { api } = await appDePrueba();
    await conInventario(api);
    const pantalla = (await api.get('/api/v1/reportes/inventario').expect(200)).body.data;
    const { body } = await pedir(api, 'inventario', { formato: 'EXCEL' }).expect(202);
    await new ExportacionesServicio().generar(body.data.id);

    const libro = new ExcelJS.Workbook();
    await libro.xlsx.readFile(join(carpeta, body.data.archivo));
    const hoja = libro.getWorksheet('Inventario valorizado')!;
    // Renglón 4: encabezados; 5: el producto; 6: totales.
    expect(hoja.getRow(4).values).to.deep.equal([undefined, 'Producto', 'Unidad', 'Existencia', 'Valor']);
    expect(hoja.getRow(5).values).to.deep.equal([
      undefined,
      pantalla.productos[0].nombre,
      'Pieza',
      Number(pantalla.productos[0].existencia),
      Number(pantalla.productos[0].valor),
    ]);
    expect(hoja.getRow(6).getCell(4).value).to.equal(Number(pantalla.totales.valor));
  });

  it('genera los 8 reportes en los dos formatos, aun sin datos', async () => {
    const { api } = await appDePrueba();
    const servicio = new ExportacionesServicio();
    for (const tipo of TIPOS_REPORTE) {
      for (const formato of ['PDF', 'EXCEL']) {
        const { body } = await pedir(api, tipo, { formato }).expect(202);
        expect((await servicio.generar(body.data.id)).estado).to.equal('LISTO');
      }
    }
    expect(await readdir(carpeta)).to.have.length(16);
  });

  it('si falla, no deja archivo a medias; al agotar los intentos queda FALLIDO (2a)', async () => {
    const { api } = await appDePrueba();
    sinon.stub(archivos, 'generarArchivoReporte').rejects(new Error('sin memoria'));
    const servicio = new ExportacionesServicio();
    const { body } = await pedir(api, 'ventas', { formato: 'PDF' }).expect(202);

    let error: Error | null = null;
    await servicio.generar(body.data.id).catch((e: Error) => (error = e));
    expect(error).to.be.instanceOf(Error);
    expect(existsSync(carpeta) ? await readdir(carpeta) : []).to.deep.equal([]);

    await servicio.marcarFallido(body.data.id, 'sin memoria');
    const lista = await api.get('/api/v1/reportes/exportaciones').expect(200);
    expect(lista.body.data[0]).to.include({ estado: 'FALLIDO', error: 'sin memoria', disponible: false });
    const descarga = await api.get(`/api/v1/reportes/archivos/${body.data.id}`).expect(409);
    expect(descarga.body.detail).to.include('pídalo de nuevo');
  });

  it('mientras se genera, la descarga lo indica', async () => {
    const { api } = await appDePrueba();
    const { body } = await pedir(api, 'ventas', { formato: 'EXCEL' }).expect(202);
    const res = await api.get(`/api/v1/reportes/archivos/${body.data.id}`).expect(409);
    expect(res.body.detail).to.include('todavía se está generando');
  });

  it('borra los archivos de más de 30 días; la fila se queda', async () => {
    const { api } = await appDePrueba();
    const servicio = new ExportacionesServicio();
    const vieja = (await pedir(api, 'cortes', { formato: 'PDF' }).expect(202)).body.data;
    await servicio.generar(vieja.id);

    // 31 días después el token ya venció: se pide directo al servicio.
    fijarHora(new Date(AHORA.getTime() + 31 * 86_400_000));
    const [dueno] = await fuenteDatos.query(`SELECT id FROM usuario WHERE rol = 'DUENO'`);
    const nueva = await servicio.pedir('cortes', { formato: 'PDF' }, dueno.id);
    await servicio.generar(nueva.id);

    expect(await readdir(carpeta)).to.deep.equal([nueva.archivo]);
    fijarHora(AHORA); // de regreso, para que el token siga vigente
    const lista = await api.get('/api/v1/reportes/exportaciones').expect(200);
    expect(lista.body.data.map((e: { disponible: boolean }) => e.disponible)).to.deep.equal([true, false]);
    const res = await api.get(`/api/v1/reportes/archivos/${vieja.id}`).expect(404);
    expect(res.body.detail).to.include('30 días');
  });

  it('revisa el formato y el periodo', async () => {
    const { api } = await appDePrueba();
    const formato = await pedir(api, 'ventas', { formato: 'WORD' }).expect(400);
    expect(formato.body.errores[0].campo).to.equal('body.formato');
    await pedir(api, 'ventas', { formato: 'PDF', desde: '2026-10-18' }).expect(422);
  });

  it('solo el Dueño exporta', async () => {
    const { api, empleado } = await appDePrueba();
    await pedir(empleado, 'ventas', { formato: 'PDF' }).expect(403);
    await empleado.get('/api/v1/reportes/exportaciones').expect(403);
    const { body } = await pedir(api, 'ventas', { formato: 'PDF' }).expect(202);
    await empleado.get(`/api/v1/reportes/archivos/${body.data.id}`).expect(403);
  });
});
