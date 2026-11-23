// Ayudantes de las pruebas: cada prueba arranca con la base de pruebas como recién instalada.
import request, { type Test } from 'supertest';
import type { Express } from 'express';
import { normalizarTexto, type ConsultaBitacora } from '@pos/compartido';
import { crearApp } from '../src/app';
import { conTransaccion } from '../src/infraestructura/base-datos/transaccion';
import { redis } from '../src/infraestructura/redis';
import { intentosPin } from '../src/modulos/acceso/acceso';
import { BitacoraServicio } from '../src/modulos/bitacora/bitacora';
import { CATEGORIAS_INICIALES } from '../src/modulos/catalogo/catalogo';
import { AHORA, adelantar, fijarHora } from './ganchos';

export { AHORA, adelantar, fijarHora };
export const PIN_INICIAL = '0000';
export const PIN_DUENO = '1111';
export const PIN_EMPLEADO = '2222';

export type Api = ReturnType<typeof cliente>;

/** Cliente de Supertest que agrega el token de acceso a cada petición. */
export function cliente(app: Express, token?: string) {
  const conToken = (t: Test) => (token ? t.set('Authorization', `Bearer ${token}`) : t);
  return {
    get: (url: string) => conToken(request(app).get(url)),
    post: (url: string) => conToken(request(app).post(url)),
    put: (url: string) => conToken(request(app).put(url)),
    patch: (url: string) => conToken(request(app).patch(url)),
    delete: (url: string) => conToken(request(app).delete(url)),
  };
}

/**
 * Deja la base como recién instalada. Se usa DELETE porque TRUNCATE es lentísimo en Docker Desktop;
 * el disparador de la bitácora se apaga solo dentro de esta transacción.
 */
export async function limpiarBase(): Promise<void> {
  await conTransaccion(async (manager) => {
    // El orden respeta las llaves foráneas: primero las tablas que apuntan a otras.
    await manager.query(
      `UPDATE configuracion_tienda SET nombre = 'Tienda de abarrotes', direccion = '', telefono = '',
         politica_devolucion = 'Devoluciones el mismo día de la compra presentando este ticket.',
         enlace_bot = '', telegram_dueno = NULL, actualizado_por = NULL`,
    );
    await manager.query('DELETE FROM movimiento_efectivo WHERE devolucion_id IS NOT NULL');
    await manager.query('DELETE FROM saldo_favor');
    await manager.query('DELETE FROM devolucion_lote');
    await manager.query('DELETE FROM devolucion_detalle');
    await manager.query('DELETE FROM devolucion');
    await manager.query('DELETE FROM pago');
    await manager.query('DELETE FROM venta_detalle_lote');
    await manager.query('DELETE FROM venta_detalle');
    await manager.query('DELETE FROM movimiento_efectivo');
    await manager.query('DELETE FROM venta');
    await manager.query('ALTER SEQUENCE venta_folio RESTART');
    await manager.query('DELETE FROM arqueo_denominacion');
    await manager.query('DELETE FROM arqueo');
    await manager.query('DELETE FROM respaldo');
    await manager.query('DELETE FROM exportacion');
    await manager.query('DELETE FROM caja');
    await manager.query('DELETE FROM sesion');
    await manager.query('DELETE FROM historial_precio');
    await manager.query('DELETE FROM entrada_detalle');
    await manager.query('DELETE FROM entrada');
    await manager.query('DELETE FROM salida');
    await manager.query('DELETE FROM ajuste_lote');
    await manager.query('DELETE FROM ajuste');
    await manager.query('DELETE FROM ejecucion_tarea');
    await manager.query('DELETE FROM lote');
    await manager.query('DELETE FROM envio');
    await manager.query('DELETE FROM consentimiento');
    await manager.query('DELETE FROM cliente');
    await manager.query('DELETE FROM promocion');
    await manager.query('DELETE FROM producto');
    await manager.query('DELETE FROM categoria');
    await manager.query('DELETE FROM proveedor');
    await manager.query('DELETE FROM usuario');
    await manager.query('ALTER TABLE bitacora DISABLE TRIGGER bitacora_sin_cambios');
    await manager.query('DELETE FROM bitacora');
    await manager.query('ALTER TABLE bitacora ENABLE TRIGGER bitacora_sin_cambios');
    for (const nombre of CATEGORIAS_INICIALES) {
      await manager.query(
        'INSERT INTO categoria (id, nombre, nombre_normalizado) VALUES (gen_random_uuid(), $1, $2)',
        [nombre, normalizarTexto(nombre)],
      );
    }
  });
  await intentosPin.reiniciar();
  // La caché también empieza vacía en cada prueba.
  await redis.flushDb();
}

/** Aplicación recién instalada: solo existe el Dueño inicial con su PIN temporal. */
export async function appNueva() {
  await limpiarBase();
  const app = crearApp();
  return { app, sinSesion: cliente(app) };
}

export async function iniciarSesion(app: Express, pin: string): Promise<string> {
  const res = await request(app).post('/api/v1/auth/pin').send({ pin }).expect(200);
  return res.body.data.tokenAcceso;
}

/**
 * Aplicación lista para operar: el Dueño ya cambió su PIN temporal y registró a un Empleado.
 * `api` usa la sesión del Dueño y `empleado` la del Empleado.
 */
export async function appDePrueba() {
  const base = await appNueva();
  const temporal = await iniciarSesion(base.app, PIN_INICIAL);
  await cliente(base.app, temporal).patch('/api/v1/auth/mi-pin').send({ pin: PIN_DUENO }).expect(200);
  const tokenDueno = await iniciarSesion(base.app, PIN_DUENO);
  const api = cliente(base.app, tokenDueno);
  const res = await api
    .post('/api/v1/usuarios')
    .send({ nombre: 'Empleado de prueba', rol: 'EMPLEADO', pin: PIN_EMPLEADO })
    .expect(201);
  const tokenEmpleado = await iniciarSesion(base.app, PIN_EMPLEADO);
  return {
    ...base,
    api,
    tokenDueno,
    tokenEmpleado,
    empleadoId: res.body.data.id as string,
    empleado: cliente(base.app, tokenEmpleado),
  };
}

/** Registros de la bitácora, del más reciente al más antiguo. */
export async function registrosBitacora(filtro: Partial<ConsultaBitacora> = {}) {
  return new BitacoraServicio().consultar({ page: 1, limit: 100, ...filtro });
}

export const productoValido = {
  codigo: '7501000111206',
  nombre: 'Frijol negro 1 kg',
  unidad: 'PIEZA',
  precio: '38.50',
  costo: '31.00',
  existenciaMinima: '5',
};
