import { expect } from 'chai';
import type { Job, Queue, Worker } from 'bullmq';
import { crearCola, crearWorker } from '../../src/infraestructura/colas';
import { redis } from '../../src/infraestructura/redis';

// En las pruebas el reloj está detenido, así que los reintentos no esperan (delay 0).
const sinEspera = { backoff: { type: 'fixed', delay: 0 } };

/** Espera a que el worker emita el evento con un trabajo. */
const esperar = (worker: Worker, evento: 'completed' | 'failed') =>
  new Promise<Job>((listo) => worker.on(evento, (job: Job | undefined) => listo(job!)));

describe('Colas de BullMQ', () => {
  let cola: Queue;
  let worker: Worker;

  beforeEach(async () => {
    await redis.flushDb();
    cola = crearCola('prueba');
  });

  afterEach(async () => {
    await worker?.close();
    await cola.close();
  });

  it('cada trabajo tiene 3 intentos con espera exponencial', () => {
    expect(cola.defaultJobOptions).to.deep.include({
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
    });
  });

  it('un trabajo que falla se reintenta y puede terminar bien', async () => {
    let intentos = 0;
    worker = crearWorker('prueba', async () => {
      intentos++;
      if (intentos < 3) throw new Error('el servicio no responde');
      return 'enviado';
    });
    const terminado = esperar(worker, 'completed');
    await cola.add('aviso', { texto: 'hola' }, sinEspera);

    const job = await terminado;
    expect(intentos).to.equal(3);
    expect(job.returnvalue).to.equal('enviado');
  });

  it('al agotar los 3 intentos queda como fallido con el motivo', async () => {
    worker = crearWorker('prueba', async () => {
      throw new Error('el servicio no responde');
    });
    const fallos: number[] = [];
    const agotado = new Promise<Job>((listo) =>
      worker.on('failed', (job: Job | undefined) => {
        fallos.push(job!.attemptsMade);
        if (job!.attemptsMade === 3) listo(job!);
      }),
    );
    await cola.add('aviso', {}, sinEspera);

    const job = await agotado;
    expect(fallos).to.deep.equal([1, 2, 3]);
    expect(await job.getState()).to.equal('failed');
    expect(job.failedReason).to.equal('el servicio no responde');
  });

  it('las claves llevan el nombre de la base para no mezclarse con desarrollo', async () => {
    await cola.add('aviso', {});
    const claves = await redis.keys('*');
    expect(claves.length).to.be.greaterThan(0);
    expect(claves.every((c) => c.startsWith('pos_pruebas:bull:prueba'))).to.equal(true);
  });
});
