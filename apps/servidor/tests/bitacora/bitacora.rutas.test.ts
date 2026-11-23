import { expect } from 'chai';
import { appDePrueba } from '../ayuda';

describe('Consulta de bitácora por HTTP', () => {
  it('el Dueño consulta los registros filtrados y paginados', async () => {
    const { api } = await appDePrueba();
    const res = await api
      .get('/api/v1/bitacora')
      .query({ accion: 'ACCESO', desde: '2026-10-17' })
      .expect(200);
    expect(res.body.meta.totalRecords).to.be.greaterThan(0);
    expect(res.body.data.every((r: { accion: string }) => r.accion === 'ACCESO')).to.equal(true);
    expect(res.body.data[0].fecha).to.match(/^2026-10-17T/);
  });

  it('no existe ninguna ruta para modificar ni borrar la bitácora', async () => {
    const { api } = await appDePrueba();
    for (const metodo of ['put', 'patch', 'delete'] as const) {
      await api[metodo]('/api/v1/bitacora').send({}).expect(404);
    }
  });
});
