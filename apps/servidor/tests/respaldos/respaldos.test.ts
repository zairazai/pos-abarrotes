import { expect } from 'chai';
import { existsSync } from 'node:fs';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from 'pg';
import sinon from 'sinon';
import type { PostgresConnectionOptions } from 'typeorm/driver/postgres/PostgresConnectionOptions';
import { fuenteDatos } from '../../src/infraestructura/base-datos/fuente';
import { guardarCache, leerCache, vaciarCache } from '../../src/infraestructura/cache';
import { claveRedis, redis } from '../../src/infraestructura/redis';
import { herramientas } from '../../src/infraestructura/respaldo';
import { RespaldosServicio } from '../../src/modulos/respaldos/respaldos';
import { AHORA, appDePrueba, appNueva, fijarHora, productoValido } from '../ayuda';

const carpeta = process.env.RESPALDOS_DIR!;
const BASE_TEMPORAL = 'pos_restauracion_prueba';

interface FilaRespaldo {
  caja_id: string | null;
  archivo: string;
  estado: string;
  error: string | null;
}
const respaldos = (): Promise<FilaRespaldo[]> =>
  fuenteDatos.query(`SELECT caja_id, archivo, estado, error FROM respaldo ORDER BY creado_en`);

/** pg_dump simulado: escribe un archivo pequeño y dice que trae 30 tablas. */
function simularHerramientas() {
  sinon.stub(herramientas, 'volcar').callsFake((archivo: string) => writeFile(archivo, 'respaldo'));
  sinon.stub(herramientas, 'revisar').resolves(30);
}

describe('Respaldos de la base de datos', () => {
  beforeEach(() => rm(carpeta, { recursive: true, force: true }));
  afterEach(() => sinon.restore());

  it('al cerrar la caja se pide un respaldo, sin esperar el pg_dump', async () => {
    const { api } = await appDePrueba();
    const apertura = await api
      .post('/api/v1/caja/apertura')
      .send({ fondoInicial: { B100: 5 } })
      .expect(201);
    await api
      .post('/api/v1/caja/arqueo')
      .send({ conteo: { B100: 5 } })
      .expect(201);
    await api.post('/api/v1/caja/cierre').send({}).expect(200);

    const [respaldo] = await respaldos();
    expect(respaldo!.caja_id).to.equal(apertura.body.data.id);
    expect(respaldo!.estado).to.equal('PENDIENTE');
    // Nombre con la base, la fecha y la hora de la tienda (08:00 en Mazatlán).
    expect(respaldo!.archivo).to.match(/^pos_pruebas_2026-10-17_08-00-00_[0-9a-f]{8}\.dump$/);
  });

  it('genera el archivo, lo revisa y queda CORRECTO con su tamaño', async () => {
    await appNueva();
    simularHerramientas();
    const servicio = new RespaldosServicio();
    const { id, archivo } = await servicio.encolar(null);

    const respaldo = await servicio.generar(id);
    expect(respaldo.estado).to.equal('CORRECTO');
    expect(respaldo.bytes).to.equal('8');
    expect(await readdir(carpeta)).to.deep.equal([archivo]);
  });

  it('si pg_dump falla queda FALLIDO con el motivo y no deja un archivo a medias', async () => {
    await appNueva();
    sinon.stub(herramientas, 'volcar').callsFake(async (archivo: string) => {
      await writeFile(archivo, 'a medias');
      throw new Error('conexión rechazada');
    });
    const servicio = new RespaldosServicio();
    const { id } = await servicio.encolar(null);

    let error: Error | null = null;
    await servicio.generar(id).catch((e: Error) => (error = e));
    expect(error).to.be.instanceOf(Error);
    const [respaldo] = await respaldos();
    expect(respaldo).to.include({ estado: 'FALLIDO', error: 'conexión rechazada' });
    expect(await readdir(carpeta)).to.deep.equal([]);
  });

  it('un respaldo que no trae tablas no sirve: queda FALLIDO', async () => {
    await appNueva();
    sinon.stub(herramientas, 'volcar').callsFake((archivo: string) => writeFile(archivo, ''));
    sinon.stub(herramientas, 'revisar').resolves(0);
    const servicio = new RespaldosServicio();
    const { id } = await servicio.encolar(null);

    await servicio.generar(id).catch(() => undefined);
    const [respaldo] = await respaldos();
    expect(respaldo).to.include({ estado: 'FALLIDO', error: 'El respaldo no contiene tablas' });
  });

  it('conserva solo los últimos 7 y la consulta dice cuáles siguen en la carpeta', async () => {
    const { api } = await appDePrueba();
    simularHerramientas();
    const servicio = new RespaldosServicio();
    for (let dia = 0; dia < 9; dia++) {
      fijarHora(new Date(AHORA.getTime() + dia * 86_400_000));
      const { id } = await servicio.encolar(null);
      await servicio.generar(id);
    }

    expect(await readdir(carpeta)).to.have.length(7);
    fijarHora(AHORA); // de regreso al día de la sesión, para que el token siga vigente
    const res = await api.get('/api/v1/respaldos').expect(200);
    expect(res.body.meta.totalRecords).to.equal(9);
    // Del más reciente al más antiguo: los dos primeros días ya se borraron.
    expect(res.body.data.map((r: { disponible: boolean }) => r.disponible)).to.deep.equal([
      ...Array<boolean>(7).fill(true),
      false,
      false,
    ]);
    expect(res.body.data[0]).to.include({ estado: 'CORRECTO', bytes: 8 });
  });

  it('solo el Dueño consulta los respaldos', async () => {
    const { empleado } = await appDePrueba();
    await empleado.get('/api/v1/respaldos').expect(403);
  });

  describe('después de restaurar', () => {
    it('el respaldo usado queda CORRECTO aunque la copia lo guardara PENDIENTE', async () => {
      await appNueva();
      const servicio = new RespaldosServicio();
      // Así queda dentro del archivo: el pg_dump corre mientras la fila sigue PENDIENTE.
      const { archivo } = await servicio.encolar(null);
      await mkdir(carpeta, { recursive: true });
      await writeFile(join(carpeta, archivo), 'respaldo');

      await servicio.marcarRestaurado(archivo);
      const [respaldo] = await respaldos();
      expect(respaldo).to.include({ estado: 'CORRECTO', error: null });
      const res = await servicio.listar({ page: 1, limit: 20 });
      expect(String(res.respaldos[0]!.bytes)).to.equal('8');
      expect(res.respaldos[0]!.terminadoEn).to.be.instanceOf(Date);
    });

    it('un respaldo FALLIDO no cambia', async () => {
      await appNueva();
      const servicio = new RespaldosServicio();
      const { id, archivo } = await servicio.encolar(null);
      await fuenteDatos.query(`UPDATE respaldo SET estado = 'FALLIDO' WHERE id = $1`, [id]);
      await servicio.marcarRestaurado(archivo);
      const [respaldo] = await respaldos();
      expect(respaldo!.estado).to.equal('FALLIDO');
    });

    it('se borra la caché de productos y promociones, no el resto de Redis', async () => {
      await vaciarCache(); // lo que hayan dejado otras pruebas
      await guardarCache('producto:codigo:7501000000042', { nombre: 'Ya no existe' }, 300);
      await guardarCache('producto:id:abc', { nombre: 'Ya no existe' }, 300);
      await guardarCache('promociones:vigentes:2026-10-17', [], 300);
      await redis.set(claveRedis('pin:bloqueo'), '1');

      expect(await vaciarCache()).to.equal(3);
      expect(await leerCache('producto:codigo:7501000000042')).to.equal(null);
      expect(await leerCache('promociones:vigentes:2026-10-17')).to.equal(null);
      expect(await redis.get(claveRedis('pin:bloqueo'))).to.equal('1');
      await redis.del(claveRedis('pin:bloqueo'));
    });

    it('las conexiones de la API no se cierran solas, para que la restauración las vea', () => {
      // Con el valor de pg (10 s), una API encendida pero sin uso no tendría conexiones abiertas.
      expect(fuenteDatos.options.extra).to.include({ idleTimeoutMillis: 0 });
    });
  });

  describe('con el pg_dump real', () => {
    before(async function () {
      if (!(await herramientas.disponible())) {
        console.warn('      (sin pg_dump: revise RESPALDO_PG_DUMP en el .env)');
        this.skip();
      }
    });

    it('respalda la base y la restaura en una base temporal', async function () {
      this.timeout(60_000);
      const { api } = await appDePrueba();
      const [categoria] = await fuenteDatos.query(`SELECT id FROM categoria WHERE nombre = 'Abarrotes'`);
      await api
        .post('/api/v1/productos')
        .send({ ...productoValido, categoriaId: categoria.id })
        .expect(201);

      const servicio = new RespaldosServicio();
      const { id, archivo } = await servicio.encolar(null);
      const respaldo = await servicio.generar(id);
      expect(respaldo.estado).to.equal('CORRECTO');
      const ruta = join(carpeta, archivo);
      expect(existsSync(ruta)).to.equal(true);
      expect(await herramientas.revisar(ruta)).to.be.greaterThan(20);

      await fuenteDatos.query(`DROP DATABASE IF EXISTS ${BASE_TEMPORAL} WITH (FORCE)`);
      await fuenteDatos.query(`CREATE DATABASE ${BASE_TEMPORAL}`);
      const o = fuenteDatos.options as PostgresConnectionOptions;
      const cliente = new Client({
        host: o.host,
        port: o.port,
        user: o.username,
        password: o.password as string,
        database: BASE_TEMPORAL,
      });
      try {
        await herramientas.restaurar(ruta, BASE_TEMPORAL, false);
        await cliente.connect();
        const { rows } = await cliente.query(`SELECT nombre FROM producto`);
        expect(rows).to.deep.equal([{ nombre: 'Frijol negro 1 kg' }]);
      } finally {
        await cliente.end().catch(() => undefined);
        await fuenteDatos.query(`DROP DATABASE IF EXISTS ${BASE_TEMPORAL} WITH (FORCE)`);
      }
    });
  });
});
