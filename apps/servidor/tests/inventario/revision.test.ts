import { expect } from 'chai';
import type { Job } from 'bullmq';
import { fuenteDatos } from '../../src/infraestructura/base-datos/fuente';
import { InventarioServicio } from '../../src/modulos/inventario/inventario';
import { iniciarProgramadas } from '../../src/trabajos/programadas';
import { appDePrueba, productoValido, registrosBitacora, type Api } from '../ayuda';
import { fijarHora } from '../ganchos';

/** Producto con un lote por caducar (en 3 días), uno caducado y uno "No aplica". */
async function preparar(api: Api) {
  const [categoria] = await fuenteDatos.query(`SELECT id FROM categoria WHERE nombre = 'Abarrotes'`);
  const producto = await api
    .post('/api/v1/productos')
    .send({ ...productoValido, categoriaId: categoria.id })
    .expect(201);
  for (const caducidad of ['2026-10-20', '2026-10-10', null]) {
    await fuenteDatos.query(
      `INSERT INTO lote (id, producto_id, caducidad, existencia, cantidad_inicial, origen, creado_en)
       VALUES (gen_random_uuid(), $1, $2, 5, 5, 'EJEMPLO', now())`,
      [producto.body.data.id, caducidad],
    );
  }
}

const ejecuciones = async () =>
  (await fuenteDatos.query(`SELECT count(*)::int AS n FROM ejecucion_tarea`))[0].n as number;

describe('Revisión diaria de caducidades', () => {
  it('registra el resumen del día una sola vez y lo anota en la bitácora', async () => {
    const { api } = await appDePrueba();
    await preparar(api);
    const servicio = new InventarioServicio();

    const resumen = await servicio.revisarCaducidades();
    expect(resumen).to.deep.include({ fecha: '2026-10-17', porCaducar: 1, caducados: 1 });
    // Otra vez el mismo día (por ejemplo, la hora programada y el arranque): no se repite.
    expect(await servicio.revisarCaducidades()).to.equal(null);
    expect(await ejecuciones()).to.equal(1);

    const { registros } = await registrosBitacora({ accion: 'REVISION_CADUCIDADES' });
    expect(registros).to.have.length(1);
    expect(registros[0]!.usuarioId).to.equal(null);
    expect(registros[0]!.despues).to.include({ porCaducar: 1, caducados: 1 });
  });

  it('está pendiente después de las 06:00 si hoy no se ha hecho', async () => {
    await appDePrueba();
    const servicio = new InventarioServicio();
    fijarHora('2026-10-17T05:59:00-07:00');
    expect(await servicio.revisionPendiente()).to.equal(false);
    fijarHora('2026-10-17T06:00:00-07:00');
    expect(await servicio.revisionPendiente()).to.equal(true);
    await servicio.revisarCaducidades();
    expect(await servicio.revisionPendiente()).to.equal(false);
    // Al día siguiente vuelve a estar pendiente.
    fijarHora('2026-10-18T07:00:00-07:00');
    expect(await servicio.revisionPendiente()).to.equal(true);
  });

  it('las alertas muestran la última revisión', async () => {
    const { api, empleado } = await appDePrueba();
    await preparar(api);
    const antes = await empleado.get('/api/v1/inventario/alertas').expect(200);
    expect(antes.body.data.ultimaRevision).to.equal(null);

    await new InventarioServicio().revisarCaducidades();
    const despues = await empleado.get('/api/v1/inventario/alertas').expect(200);
    expect(despues.body.data.ultimaRevision).to.include({
      fecha: '2026-10-17',
      porCaducar: 1,
      caducados: 1,
    });
  });

  it('el worker la programa a diario y, si está pendiente al arrancar, la hace', async () => {
    const { api } = await appDePrueba();
    await preparar(api);
    const { cola, worker } = await iniciarProgramadas();
    try {
      const hecha = new Promise<Job>((listo) => worker.on('completed', (job: Job) => listo(job)));
      const job = await hecha;
      expect(job.name).to.equal('revision-caducidades');
      expect(await ejecuciones()).to.equal(1);

      const programada = await cola.getJobScheduler('revision-caducidades');
      expect(programada).to.deep.include({ pattern: '0 6 * * *', tz: 'America/Mazatlan' });
    } finally {
      await worker.close();
      await cola.close();
    }
  });
});
