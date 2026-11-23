import { expect } from 'chai';
import { BitacoraServicio } from '../../src/modulos/bitacora/bitacora';
import { fijarHora, limpiarBase } from '../ayuda';

const USUARIO = '0b6a1d0e-3f4c-4a8e-9d55-2c1e7f9a1b23';

describe('Bitácora', () => {
  const bitacora = new BitacoraServicio();

  beforeEach(async () => {
    await limpiarBase();
  });

  it('registra fecha, usuario, acción, entidad y valores anteriores y nuevos', async () => {
    await bitacora.registrar({
      usuarioId: USUARIO,
      accion: 'PRODUCTO_PRECIO',
      entidad: 'producto',
      entidadId: 'p1',
      antes: { precio: '38.50' },
      despues: { precio: '40.00' },
    });
    const { registros } = await bitacora.consultar({ page: 1, limit: 20 });
    expect(registros).to.have.length(1);
    expect(registros[0]).to.include({ usuarioId: USUARIO, accion: 'PRODUCTO_PRECIO', entidad: 'producto' });
    expect(registros[0]!.fecha.toISOString()).to.equal('2026-10-17T15:00:00.000Z');
    expect(registros[0]!.antes).to.deep.equal({ precio: '38.50' });
  });

  it('el servicio no ofrece funciones para modificar ni borrar', () => {
    const metodos = Object.getOwnPropertyNames(BitacoraServicio.prototype);
    expect(metodos.filter((m) => /actualiz|modific|borr|elimin|update|delete/i.test(m))).to.deep.equal([]);
  });

  it('filtra por días locales, usuario y acción, del más reciente al más antiguo', async () => {
    const registrarEn = async (instante: string, usuarioId: string | null, accion: string) => {
      fijarHora(instante);
      await bitacora.registrar({ usuarioId, accion, entidad: 'sesion' });
    };
    await registrarEn('2026-10-16T20:00:00Z', USUARIO, 'ACCESO'); // 16 de octubre, 13:00 en Mazatlán
    await registrarEn('2026-10-18T06:30:00Z', USUARIO, 'ACCESO'); // 17 de octubre, 23:30 en Mazatlán
    await registrarEn('2026-10-18T08:00:00Z', null, 'ACCESO_FALLIDO'); // 18 de octubre, 01:00 en Mazatlán

    const delDia = await bitacora.consultar({ page: 1, limit: 20, desde: '2026-10-17', hasta: '2026-10-17' });
    expect(delDia.registros.map((r) => r.fecha.toISOString())).to.deep.equal(['2026-10-18T06:30:00.000Z']);

    const accesos = await bitacora.consultar({ page: 1, limit: 20, accion: 'ACCESO', usuarioId: USUARIO });
    expect(accesos.total).to.equal(2);
    expect(accesos.registros[0]!.fecha.toISOString()).to.equal('2026-10-18T06:30:00.000Z');
  });
});
