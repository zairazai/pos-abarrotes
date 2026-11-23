import { expect } from 'chai';
import { PERMISOS, ROLES, permisosDe, tienePermiso } from '../../src/acceso/permisos';

describe('Permisos por rol', () => {
  it('existen solo los roles Dueño y Empleado', () => {
    expect(ROLES).to.deep.equal(['DUENO', 'EMPLEADO']);
  });

  it('el Dueño tiene todos los permisos', () => {
    expect(permisosDe('DUENO')).to.have.members([...PERMISOS]);
  });

  it('el Empleado vende, cobra, opera la caja y el inventario', () => {
    for (const permiso of [
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
    ] as const) {
      expect(tienePermiso('EMPLEADO', permiso), permiso).to.equal(true);
    }
  });

  it('el Empleado no tiene ninguna de las restricciones del Dueño', () => {
    for (const permiso of [
      'producto:precio',
      'producto:crear',
      'producto:desactivar',
      'categoria:crear',
      'categoria:eliminar',
      'proveedor:crear',
      'venta:descuento',
      'promocion:configurar',
      'reporte:consultar',
      'bitacora:consultar',
      'usuario:registrar',
      'configuracion:modificar',
      'venta:cancelar_cobrada',
      'devolucion:total',
      'caja:ver_esperado',
    ] as const) {
      expect(tienePermiso('EMPLEADO', permiso), permiso).to.equal(false);
    }
  });
});
