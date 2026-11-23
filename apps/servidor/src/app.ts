/**
 * La aplicación Express completa: aquí se juntan la seguridad, las rutas de cada módulo, Swagger y el
 * manejo de errores. Ojo: aquí no se abre el puerto (eso lo hace main-api.ts); así las pruebas pueden
 * usar la aplicación sin tener que encender el servidor.
 */
import express, { type Express } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import { rateLimit } from 'express-rate-limit';
import swaggerUi from 'swagger-ui-express';
import { z } from 'zod';
import { configuracion } from './config';
import { manejadorDeErrores, rutaNoEncontrada } from './comun/errores';
import { crearRegistro, generarEspecificacion, opcionesSwaggerUi } from './documentacion/openapi';
import { documentarAcceso, rutasAcceso } from './modulos/acceso/acceso';
import { documentarBitacora, rutasBitacora } from './modulos/bitacora/bitacora';
import {
  documentarCaja,
  registrarParticipanteCierre,
  registrarProveedorAlertas,
  rutasCaja,
} from './modulos/caja/caja';
import { documentarCatalogo, rutasCatalogo } from './modulos/catalogo/catalogo';
import { documentarConfiguracion, rutasConfiguracion } from './modulos/configuracion/configuracion';
import { documentarInventario, InventarioServicio, rutasInventario } from './modulos/inventario/inventario';
import { documentarProveedores, rutasProveedores } from './modulos/proveedores/proveedores';
import { documentarDevoluciones, rutasDevoluciones } from './modulos/devoluciones/devoluciones';
import { documentarPromociones, rutasPromociones } from './modulos/promociones/promociones';
import { documentarClientes, rutasClientes } from './modulos/clientes/clientes';
import { documentarNotificaciones, rutasNotificaciones } from './modulos/notificaciones/notificaciones';
import { documentarReportes, rutasReportes } from './modulos/reportes/reportes';
import { documentarRespaldos, rutasRespaldos } from './modulos/respaldos/respaldos';
import { documentarSalud, rutasSalud } from './modulos/salud/salud';
import { documentarUsuarios, rutasUsuarios, UsuariosServicio } from './modulos/usuarios/usuarios';
import { documentarVentas, rutasVentas, VentasServicio } from './modulos/ventas/ventas';

/** Mensajes de validación de Zod en español. */
z.config(z.locales.es());

/** Versión que se muestra en /salud y en Swagger. */
export const VERSION = '4.0.0';

/** Antes de llamar a esta función, la conexión a PostgreSQL ya tiene que estar abierta. */
export function crearApp(): Express {
  const app = express();

  // --- Seguridad y formato ---
  app.disable('x-powered-by'); // así no se anda anunciando que el servidor es Express
  app.use(helmet()); // cabeceras de seguridad
  app.use(
    // Desde un navegador, solo los orígenes de la lista pueden llamar a la API. Las peticiones que no
    // traen origen (Postman, las pruebas) sí pasan.
    cors({
      origin: (origen, permitir) =>
        permitir(null, !origen || configuracion.origenesPermitidos.includes(origen)),
    }),
  );
  app.use(compression());
  app.use(express.json({ limit: '100kb' }));

  // --- Preparativos ---
  // Ventas se apunta con caja para que, al cerrar, se puedan cancelar las ventas abiertas (ver caja.ts).
  registrarParticipanteCierre(new VentasServicio());
  // Inventario se apunta con caja para dar el resumen de alertas al abrir.
  registrarProveedorAlertas(new InventarioServicio());

  // La primera vez se crea el Dueño con un PIN temporal; ninguna petición se atiende antes de eso.
  const duenoInicial = new UsuariosServicio().asegurarDuenoInicial();
  app.use((_req, _res, next) => {
    duenoInicial.then(() => next(), next);
  });

  // --- Límites de peticiones ---
  // El general es amplio porque al escanear rápido se juntan muchas peticiones; el del PIN es estricto
  // para que nadie se ponga a probar PIN al azar.
  const limiteGeneral = rateLimit({
    windowMs: 60_000,
    limit: 600,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
  });
  const limitePin = rateLimit({
    windowMs: 60_000,
    limit: 30,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
  });

  // --- Rutas (todas bajo /api/v1) ---
  const api = express.Router();
  api.use('/auth/pin', limitePin);
  api.use(rutasSalud(VERSION));
  api.use(rutasAcceso());
  api.use(rutasUsuarios());
  api.use(rutasBitacora());
  api.use(rutasCatalogo());
  api.use(rutasConfiguracion());
  api.use(rutasCaja());
  api.use(rutasVentas());
  api.use(rutasProveedores());
  api.use(rutasInventario());
  api.use(rutasDevoluciones());
  api.use(rutasPromociones());
  api.use(rutasClientes());
  api.use(rutasNotificaciones());
  api.use(rutasRespaldos());
  api.use(rutasReportes());
  app.use('/api/v1', limiteGeneral, api);

  // --- Swagger (/api-docs) ---
  const registro = crearRegistro();
  documentarSalud(registro);
  documentarAcceso(registro);
  documentarUsuarios(registro);
  documentarBitacora(registro);
  documentarCatalogo(registro);
  documentarConfiguracion(registro);
  documentarCaja(registro);
  documentarVentas(registro);
  documentarProveedores(registro);
  documentarInventario(registro);
  documentarDevoluciones(registro);
  documentarPromociones(registro);
  documentarClientes(registro);
  documentarNotificaciones(registro);
  documentarRespaldos(registro);
  documentarReportes(registro);
  const especificacion = generarEspecificacion(registro, VERSION);
  app.get('/api-docs.json', (_req, res) => {
    res.json(especificacion);
  });
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(especificacion, opcionesSwaggerUi));

  // --- Errores ---
  // Ruta que no existe → 404; cualquier error que se lance llega al manejador central (comun/errores.ts).
  app.use(rutaNoEncontrada);
  app.use(manejadorDeErrores);
  return app;
}
