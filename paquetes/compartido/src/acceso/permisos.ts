/**
 * Roles y permisos. Cada permiso se escribe "tema:acción" (por ejemplo 'producto:precio') y
 * autorizar() lo revisa con tienePermiso(). Si se quiere que el Empleado pueda hacer algo más (o
 * menos), basta con mover el permiso de una lista a la otra.
 */
/** Los dos roles que hay: Dueño y Empleado. */
export const ROLES = ['DUENO', 'EMPLEADO'] as const;
export type Rol = (typeof ROLES)[number];

/** Lo que pueden hacer los dos, Empleado y Dueño. */
const PERMISOS_COMUNES = [
  'venta:cobrar',
  'venta:cancelar_en_curso',
  'ticket:reimprimir',
  'devolucion:parcial',
  'caja:abrir',
  'caja:movimiento',
  'caja:cerrar',
  'inventario:entrada',
  'inventario:salida',
  'inventario:ajuste',
  'inventario:consultar',
  'producto:consultar',
  'cliente:registrar',
  'cliente:baja',
] as const;

/** Lo que solo puede hacer el Dueño (es regla de la tienda). */
const PERMISOS_DUENO = [
  'venta:descuento',
  'venta:cancelar_cobrada',
  'devolucion:total',
  'caja:ver_esperado',
  'caja:fondo_inicial',
  'producto:crear',
  'producto:modificar',
  'producto:precio',
  'producto:desactivar',
  'categoria:crear',
  'categoria:eliminar',
  'proveedor:crear',
  'promocion:configurar',
  'reporte:consultar',
  'reporte:exportar',
  'bitacora:consultar',
  'envio:consultar',
  'respaldo:consultar',
  'usuario:consultar',
  'usuario:registrar',
  'usuario:restablecer_pin',
  'usuario:desactivar',
  'configuracion:consultar',
  'configuracion:modificar',
] as const;

export const PERMISOS = [...PERMISOS_COMUNES, ...PERMISOS_DUENO] as const;
export type Permiso = (typeof PERMISOS)[number];

const POR_ROL: Record<Rol, ReadonlySet<Permiso>> = {
  DUENO: new Set(PERMISOS),
  EMPLEADO: new Set(PERMISOS_COMUNES),
};

export function permisosDe(rol: Rol): Permiso[] {
  return [...POR_ROL[rol]];
}

export function tienePermiso(rol: Rol, permiso: Permiso): boolean {
  return POR_ROL[rol].has(permiso);
}
