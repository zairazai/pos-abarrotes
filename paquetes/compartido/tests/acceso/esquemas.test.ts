import { expect } from 'chai';
import {
  esquemaInicioSesion,
  esquemaUsuarioNuevo,
  esquemaPreferencias,
  esquemaConsultaBitacora,
} from '../../src/acceso/esquemas';

describe('Esquemas de acceso y usuarios', () => {
  it('el PIN es numérico de exactamente 4 dígitos', () => {
    expect(esquemaInicioSesion.safeParse({ pin: '0427' }).success).to.equal(true);
    for (const pin of ['427', '04271', 'abcd', '04 7', 4271]) {
      expect(esquemaInicioSesion.safeParse({ pin }).success, String(pin)).to.equal(false);
    }
  });

  it('el inicio de sesión distingue el desbloqueo por inactividad', () => {
    expect(esquemaInicioSesion.parse({ pin: '1234' }).motivo).to.equal('INICIO');
    expect(esquemaInicioSesion.parse({ pin: '1234', motivo: 'DESBLOQUEO' }).motivo).to.equal('DESBLOQUEO');
  });

  it('un usuario nuevo lleva nombre, rol, PIN y preferencia de modo accesible', () => {
    const r = esquemaUsuarioNuevo.parse({ nombre: ' Ana ', rol: 'EMPLEADO', pin: '5555' });
    expect(r).to.deep.equal({ nombre: 'Ana', rol: 'EMPLEADO', pin: '5555', modoAccesible: false });
    expect(esquemaUsuarioNuevo.safeParse({ nombre: 'Ana', rol: 'GERENTE', pin: '5555' }).success).to.equal(
      false,
    );
  });

  it('el tamaño de letra va de 100 % a 300 %', () => {
    expect(esquemaPreferencias.safeParse({ tamanoLetra: 200 }).success).to.equal(true);
    expect(esquemaPreferencias.safeParse({ tamanoLetra: 350 }).success).to.equal(false);
    expect(esquemaPreferencias.safeParse({}).success).to.equal(false);
  });

  it('la consulta de bitácora acepta filtros por fechas, usuario y acción', () => {
    const r = esquemaConsultaBitacora.parse({ desde: '2026-10-01', accion: 'ACCESO' });
    expect(r).to.include({ page: 1, limit: 20, desde: '2026-10-01', accion: 'ACCESO' });
    expect(esquemaConsultaBitacora.safeParse({ desde: '01/10/2026' }).success).to.equal(false);
  });
});
