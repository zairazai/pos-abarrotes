import { expect } from 'chai';
import { appDePrueba, productoValido, AHORA, registrosBitacora, type Api } from '../ayuda';
import { fuenteDatos } from '../../src/infraestructura/base-datos/fuente';
import { ProductoEntidad } from '../../src/modulos/catalogo/catalogo.tablas';

async function categoria(api: Api, nombre = 'Abarrotes'): Promise<string> {
  const res = await api.get('/api/v1/categorias');
  return res.body.data.find((c: { nombre: string }) => c.nombre === nombre).id;
}

async function registrar(api: Api, datos: Record<string, unknown> = {}, estado = 201) {
  const categoriaId = await categoria(api);
  return api
    .post('/api/v1/productos')
    .send({ ...productoValido, categoriaId, ...datos })
    .expect(estado);
}

describe('Productos', () => {
  describe('registrar', () => {
    it('guarda el producto activo y lo devuelve con montos en texto', async () => {
      const { api } = await appDePrueba();
      const res = await registrar(api, {}, 201);
      expect(res.body.success).to.equal(true);
      expect(res.body.data).to.include({
        codigo: '7501000111206',
        nombre: 'Frijol negro 1 kg',
        unidad: 'PIEZA',
        precio: '38.50',
        costo: '31.00',
        existenciaMinima: '5.00',
        activo: true,
        creadoEn: AHORA.toISOString(),
      });
    });

    it('rechaza un código repetido', async () => {
      const { api } = await appDePrueba();
      await registrar(api, {}, 201);
      const res = await registrar(api, { nombre: 'Otro' }, 409);
      expect(res.body.detail).to.match(/7501000111206/);
    });

    it('indica el campo exacto que falta', async () => {
      const { api } = await appDePrueba();
      const res = await registrar(api, { precio: undefined }, 400);
      expect(res.body.errores).to.deep.include({ campo: 'body.precio', mensaje: 'Es obligatorio' });
    });

    it('rechaza una categoría que no existe', async () => {
      const { api } = await appDePrueba();
      const res = await registrar(api, { categoriaId: '3f1c2b8e-8a4d-4c55-9a77-6c1d2f0e9b10' }, 422);
      expect(res.body.detail).to.match(/categoría/);
    });
  });

  describe('buscar', () => {
    it('un código existente devuelve su producto', async () => {
      const { api } = await appDePrueba();
      await registrar(api);
      const res = await api.get('/api/v1/productos/codigo/7501000111206').expect(200);
      expect(res.body.data.nombre).to.equal('Frijol negro 1 kg');
    });

    it('un código inexistente responde 404 y no devuelve producto', async () => {
      const { api } = await appDePrueba();
      const res = await api.get('/api/v1/productos/codigo/000').expect(404);
      expect(res.body.detail).to.match(/000/);
    });

    it('una búsqueda parcial por nombre devuelve todas las coincidencias activas, sin importar acentos', async () => {
      const { api } = await appDePrueba();
      await registrar(api, { codigo: 'A1', nombre: 'Jamón de pavo' });
      await registrar(api, { codigo: 'A2', nombre: 'Jamon serrano' });
      await registrar(api, { codigo: 'A3', nombre: 'Queso panela' });
      const res = await api.get('/api/v1/productos').query({ buscar: 'JAMÓN' }).expect(200);
      expect(res.body.data.map((p: { nombre: string }) => p.nombre)).to.deep.equal([
        'Jamón de pavo',
        'Jamon serrano',
      ]);
    });

    it('también encuentra por el inicio del código interno', async () => {
      const { api } = await appDePrueba();
      await registrar(api, { codigo: 'GR-ARROZ', nombre: 'Arroz a granel', unidad: 'KG' });
      const res = await api.get('/api/v1/productos').query({ buscar: 'gr-' }).expect(200);
      expect(res.body.data).to.have.length(1);
    });

    it('pagina el listado con metadatos', async () => {
      const { api } = await appDePrueba();
      for (let i = 1; i <= 5; i++) await registrar(api, { codigo: `P${i}`, nombre: `Producto ${i}` });
      const res = await api.get('/api/v1/productos').query({ page: 2, limit: 2 }).expect(200);
      expect(res.body.data.map((p: { codigo: string }) => p.codigo)).to.deep.equal(['P3', 'P4']);
      expect(res.body.meta).to.deep.equal({ page: 2, limit: 2, totalPages: 3, totalRecords: 5 });
    });

    it('filtra por categoría', async () => {
      const { api } = await appDePrueba();
      await registrar(api, { codigo: 'B1' });
      const bebidas = await categoria(api, 'Bebidas');
      await registrar(api, { codigo: 'B2', nombre: 'Agua 1 L', categoriaId: bebidas });
      const res = await api.get('/api/v1/productos').query({ categoriaId: bebidas }).expect(200);
      expect(res.body.data.map((p: { codigo: string }) => p.codigo)).to.deep.equal(['B2']);
    });

    it('responde 400 con un id que no es UUID', async () => {
      const { api } = await appDePrueba();
      const res = await api.get('/api/v1/productos/abc').expect(400);
      expect(res.body.errores[0].campo).to.equal('params.id');
    });
  });

  describe('modificar', () => {
    it('cambia los datos sin tocar el precio', async () => {
      const { api } = await appDePrueba();
      const creado = await registrar(api);
      const { precio: _p, ...datos } = { ...productoValido, categoriaId: creado.body.data.categoriaId };
      const res = await api
        .put(`/api/v1/productos/${creado.body.data.id}`)
        .send({ ...datos, nombre: 'Frijol negro 900 g', existenciaMinima: '8' })
        .expect(200);
      expect(res.body.data).to.include({
        nombre: 'Frijol negro 900 g',
        existenciaMinima: '8.00',
        precio: '38.50',
      });
    });

    it('rechaza el precio en la modificación', async () => {
      const { api } = await appDePrueba();
      const creado = await registrar(api);
      await api
        .put(`/api/v1/productos/${creado.body.data.id}`)
        .send({ ...productoValido, categoriaId: creado.body.data.categoriaId })
        .expect(400);
    });

    it('rechaza un código que ya usa otro producto', async () => {
      const { api } = await appDePrueba();
      await registrar(api, { codigo: 'X1' });
      const otro = await registrar(api, { codigo: 'X2' });
      const { precio: _p, ...datos } = { ...productoValido, categoriaId: otro.body.data.categoriaId };
      await api
        .put(`/api/v1/productos/${otro.body.data.id}`)
        .send({ ...datos, codigo: 'X1' })
        .expect(409);
    });

    it('responde 404 si el producto no existe', async () => {
      const { api } = await appDePrueba();
      const categoriaId = await categoria(api);
      const { precio: _p, ...datos } = { ...productoValido, categoriaId };
      await api.put('/api/v1/productos/3f1c2b8e-8a4d-4c55-9a77-6c1d2f0e9b10').send(datos).expect(404);
    });
  });

  describe('cambiar precio', () => {
    it('guarda el precio nuevo y agrega el historial con precio anterior, nuevo, fecha y usuario', async () => {
      const { api } = await appDePrueba();
      const yo = (await api.get('/api/v1/auth/yo')).body.data.usuario.id;
      const creado = await registrar(api);
      const id = creado.body.data.id;
      const res = await api.patch(`/api/v1/productos/${id}/precio`).send({ precio: '40.00' }).expect(200);
      expect(res.body.data.precio).to.equal('40.00');
      const historial = await api.get(`/api/v1/productos/${id}/precios`).expect(200);
      expect(historial.body.data).to.deep.equal([
        { precioAnterior: '38.50', precioNuevo: '40.00', fecha: AHORA.toISOString(), usuarioId: yo },
      ]);
    });

    it('rechaza un precio igual al actual', async () => {
      const { api } = await appDePrueba();
      const creado = await registrar(api);
      await api.patch(`/api/v1/productos/${creado.body.data.id}/precio`).send({ precio: '38.5' }).expect(422);
    });

    it('rechaza un precio no positivo', async () => {
      const { api } = await appDePrueba();
      const creado = await registrar(api);
      await api.patch(`/api/v1/productos/${creado.body.data.id}/precio`).send({ precio: '0' }).expect(400);
    });
  });

  describe('desactivar', () => {
    it('un producto desactivado no aparece al vender ni al buscar', async () => {
      const { api } = await appDePrueba();
      const creado = await registrar(api);
      const id = creado.body.data.id;
      await api.delete(`/api/v1/productos/${id}`).expect(200);
      await api.get('/api/v1/productos/codigo/7501000111206').expect(404);
      await api.get(`/api/v1/productos/${id}`).expect(404);
      const lista = await api.get('/api/v1/productos').query({ buscar: 'frijol' });
      expect(lista.body.data).to.have.length(0);
      // No se borra: sigue guardado para ventas y reportes pasados.
      const guardado = await fuenteDatos.getRepository(ProductoEntidad).findOneBy({ id });
      expect(guardado).to.include({ activo: false });
      expect(guardado!.desactivadoEn).to.deep.equal(AHORA);
    });

    it('responde 404 al desactivar dos veces', async () => {
      const { api } = await appDePrueba();
      const creado = await registrar(api);
      await api.delete(`/api/v1/productos/${creado.body.data.id}`).expect(200);
      await api.delete(`/api/v1/productos/${creado.body.data.id}`).expect(404);
    });

    it('su código no se puede reutilizar, porque sigue en las ventas pasadas', async () => {
      const { api } = await appDePrueba();
      const creado = await registrar(api);
      await api.delete(`/api/v1/productos/${creado.body.data.id}`);
      const res = await registrar(api, {}, 409);
      expect(res.body.detail).to.match(/desactivado/);
    });
  });

  describe('bitácora del catálogo', () => {
    it('la modificación guarda los valores anteriores y nuevos', async () => {
      const { api } = await appDePrueba();
      const creado = await registrar(api);
      const { precio: _p, ...datos } = { ...productoValido, categoriaId: creado.body.data.categoriaId };
      await api
        .put(`/api/v1/productos/${creado.body.data.id}`)
        .send({ ...datos, nombre: 'Frijol negro 900 g' })
        .expect(200);
      const { registros } = await registrosBitacora({ accion: 'PRODUCTO_MODIFICADO' });
      expect(registros).to.have.length(1);
      expect(registros[0]!.antes).to.include({ nombre: 'Frijol negro 1 kg' });
      expect(registros[0]!.despues).to.include({ nombre: 'Frijol negro 900 g' });
      expect(registros[0]!.usuarioId).to.be.a('string');
    });

    it('registra el alta, el cambio de precio, la desactivación y los cambios de categorías', async () => {
      const { api } = await appDePrueba();
      const creado = await registrar(api);
      await api.patch(`/api/v1/productos/${creado.body.data.id}/precio`).send({ precio: '40.00' });
      await api.delete(`/api/v1/productos/${creado.body.data.id}`);
      const categoria = await api.post('/api/v1/categorias').send({ nombre: 'Mascotas' });
      await api.delete(`/api/v1/categorias/${categoria.body.data.id}`);
      const { registros } = await registrosBitacora();
      expect(registros.map((r) => r.accion)).to.include.members([
        'PRODUCTO_REGISTRADO',
        'PRODUCTO_PRECIO',
        'PRODUCTO_DESACTIVADO',
        'CATEGORIA_REGISTRADA',
        'CATEGORIA_ELIMINADA',
      ]);
    });
  });
});
