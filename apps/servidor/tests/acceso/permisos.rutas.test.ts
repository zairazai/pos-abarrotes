import { expect } from 'chai';
import request from 'supertest';
import { tienePermiso, type Permiso } from '@pos/compartido';
import { appDePrueba, appNueva, type Api } from '../ayuda';

type Metodo = keyof Api;

interface Operacion {
  metodo: Metodo;
  ruta: string;
  publica: boolean;
  permiso?: Permiso;
}

const ID_EJEMPLO = '3f1c2b8e-8a4d-4c55-9a77-6c1d2f0e9b10';
const conValores = (ruta: string) => ruta.replace(/\{id\}/g, ID_EJEMPLO).replace(/\{\w+\}/g, 'X1');

/** Lee de Swagger todas las rutas con su permiso (campo x-permiso) y si piden sesión. */
async function operacionesDocumentadas(): Promise<Operacion[]> {
  const { app } = await appNueva();
  const { body } = await request(app).get('/api-docs.json').expect(200);
  const operaciones: Operacion[] = [];
  for (const [ruta, metodos] of Object.entries<Record<string, { security?: unknown; 'x-permiso'?: Permiso }>>(
    body.paths,
  )) {
    for (const [metodo, operacion] of Object.entries(metodos)) {
      operaciones.push({
        metodo: metodo as Metodo,
        ruta,
        publica: !operacion.security,
        permiso: operacion['x-permiso'],
      });
    }
  }
  return operaciones;
}

describe('Permisos en la API', () => {
  let operaciones: Operacion[] = [];

  before(async () => {
    operaciones = await operacionesDocumentadas();
  });

  it('Swagger documenta las rutas con su permiso', () => {
    expect(operaciones.length).to.be.greaterThan(20);
    expect(operaciones.filter((o) => o.permiso).length).to.be.greaterThan(15);
  });

  it('toda ruta, salvo las públicas, exige sesión (401 sin token)', async () => {
    const { sinSesion } = await appNueva();
    for (const o of operaciones.filter((x) => !x.publica)) {
      const res = await sinSesion[o.metodo](conValores(o.ruta)).send({});
      expect(res.status, `${o.metodo.toUpperCase()} ${o.ruta}`).to.equal(401);
    }
  });

  it('el 100 % de las rutas exclusivas del Dueño rechaza al Empleado con 403', async () => {
    const { empleado } = await appDePrueba();
    const restringidas = operaciones.filter((o) => o.permiso && !tienePermiso('EMPLEADO', o.permiso));
    expect(restringidas.length).to.be.greaterThan(5);
    for (const o of restringidas) {
      const res = await empleado[o.metodo](conValores(o.ruta)).send({});
      expect(res.status, `${o.metodo.toUpperCase()} ${o.ruta}`).to.equal(403);
      expect(res.body.detail).to.match(/permiso/);
    }
  });
});
