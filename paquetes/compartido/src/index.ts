/**
 * Paquete que comparten el servidor y la interfaz, para que los dos calculen y validen igualito.
 * dominio/: las cuentas del negocio (funciones puras); esquemas/: validación con Zod; acceso/: roles
 * y permisos.
 */
export * from './dominio/importe';
export * from './dominio/pagos';
export * from './dominio/promociones';
export * from './dominio/formato';
export * from './dominio/caja';
export * from './dominio/inventario';
export * from './dominio/ventas';
export * from './dominio/devoluciones';
export * from './dominio/notificaciones';
export * from './dominio/reportes';
export * from './esquemas/comunes';
export * from './esquemas/catalogo';
export * from './esquemas/configuracion';
export * from './esquemas/caja';
export * from './esquemas/ventas';
export * from './esquemas/inventario';
export * from './esquemas/devoluciones';
export * from './esquemas/promociones';
export * from './esquemas/clientes';
export * from './esquemas/notificaciones';
export * from './esquemas/respaldos';
export * from './esquemas/reportes';
export { default as Decimal } from 'decimal.js';
export * from './acceso/permisos';
export * from './acceso/esquemas';
