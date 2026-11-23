/**
 * Módulo catálogo: productos y categorías.
 * Aquí están las reglas (CatalogoServicio), las rutas y la documentación de Swagger; las entidades
 * están en catalogo.tablas.ts. Los productos activos se guardan 5 minutos en Redis para que las
 * búsquedas sean rápidas, y se borran de ahí en cuanto se modifican.
 */
import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import {
  dinero,
  esquemaCambioPrecio,
  esquemaCategoria,
  esquemaCategoriaNueva,
  esquemaCodigo,
  esquemaConsultaProductos,
  esquemaHistorialPrecio,
  esquemaId,
  esquemaProducto,
  esquemaProductoConExistencia,
  esquemaProductoModificado,
  esquemaProductoNuevo,
  normalizarTexto,
  peso,
  type CambioPrecio,
  type CategoriaNueva,
  type ConsultaProductos,
  type Producto,
  type ProductoModificado,
  type ProductoNuevo,
} from '@pos/compartido';
import { Conflicto, NoEncontrado, ReglaDeNegocio } from '../../comun/errores';
import { documentar } from '../../comun/documentar';
import { paginacion, responder } from '../../comun/respuesta';
import { sesionDe } from '../../comun/sesion';
import { datos, validar } from '../../comun/validar';
import { fuenteDatos } from '../../infraestructura/base-datos/fuente';
import { borrarCache, clavesProducto, guardarCache, leerCache } from '../../infraestructura/cache';
import { conTransaccion, textoLiteral } from '../../infraestructura/base-datos/transaccion';
import { autenticar, autorizar } from '../../comun/seguridad';
import { BitacoraServicio } from '../bitacora/bitacora';
import { InventarioServicio } from '../inventario/inventario';
import { CategoriaEntidad, HistorialPrecioEntidad, ProductoEntidad } from './catalogo.tablas';

/** Producto en el formato de la respuesta: montos como texto ("18.50") y fechas ISO. */
export function aProducto(p: ProductoEntidad): Producto {
  return {
    id: p.id,
    codigo: p.codigo,
    nombre: p.nombre,
    unidad: p.unidad,
    precio: p.precio.toFixed(2),
    costo: p.costo.toFixed(2),
    existenciaMinima: p.existenciaMinima.toFixed(2),
    categoriaId: p.categoriaId,
    activo: p.activo,
    creadoEn: p.creadoEn.toISOString(),
    actualizadoEn: p.actualizadoEn.toISOString(),
  };
}

/** Producto tal como se guarda en la caché: el de la respuesta más su nombre normalizado. */
type ProductoEnCache = Producto & { nombreNormalizado: string };

/** Segundos que dura un producto en la caché. */
const SEGUNDOS_CACHE = 300;

// --- Reglas ---
// Si una regla no se cumple se lanza un error (Conflicto, NoEncontrado o ReglaDeNegocio) y el
// manejador central responde con 409, 404 o 422.

/** Categorías con las que arranca la tienda; las crea la migración inicial. */
export const CATEGORIAS_INICIALES = [
  'Abarrotes',
  'Granel',
  'Bebidas',
  'Lácteos y salchichonería',
  'Botanas y dulces',
  'Panadería',
  'Limpieza',
  'Higiene personal',
];

export class CatalogoServicio {
  private productos = fuenteDatos.getRepository(ProductoEntidad);
  private categorias = fuenteDatos.getRepository(CategoriaEntidad);
  private historial = fuenteDatos.getRepository(HistorialPrecioEntidad);
  private bitacora = new BitacoraServicio();

  // Productos

  /** Alta de producto. */
  async registrarProducto(datos: ProductoNuevo, usuarioId: string): Promise<ProductoEntidad> {
    await this.validarCodigoLibre(datos.codigo);
    await this.validarCategoria(datos.categoriaId);

    const producto = this.productos.create({
      id: randomUUID(),
      codigo: datos.codigo,
      nombre: datos.nombre,
      nombreNormalizado: normalizarTexto(datos.nombre),
      unidad: datos.unidad,
      precio: dinero(datos.precio),
      costo: dinero(datos.costo),
      existenciaMinima: peso(datos.existenciaMinima),
      categoriaId: datos.categoriaId,
      activo: true,
      creadoEn: new Date(),
      actualizadoEn: new Date(),
      desactivadoEn: null,
    });

    // El producto y su registro en la bitácora se guardan en la misma transacción.
    return conTransaccion(async (manager) => {
      await manager.save(producto);
      await this.bitacora.registrar(
        {
          usuarioId,
          accion: 'PRODUCTO_REGISTRADO',
          entidad: 'producto',
          entidadId: producto.id,
          despues: aProducto(producto),
        },
        manager,
      );
      return producto;
    });
  }

  /** Cambiar los datos de un producto; el precio va aparte, con cambiarPrecio. */
  async modificarProducto(
    id: string,
    datos: ProductoModificado,
    usuarioId: string,
  ): Promise<ProductoEntidad> {
    const producto = await this.productoActivo(id);
    // El código solo se rechaza si ya lo trae otro producto.
    await this.validarCodigoLibre(datos.codigo, id);
    await this.validarCategoria(datos.categoriaId);

    // Cómo estaba antes, para la bitácora.
    const antes = aProducto(producto);
    producto.codigo = datos.codigo;
    producto.nombre = datos.nombre;
    producto.nombreNormalizado = normalizarTexto(datos.nombre);
    producto.unidad = datos.unidad;
    producto.costo = dinero(datos.costo);
    producto.existenciaMinima = peso(datos.existenciaMinima);
    producto.categoriaId = datos.categoriaId;
    producto.actualizadoEn = new Date();

    await conTransaccion(async (manager) => {
      await manager.save(producto);
      await this.bitacora.registrar(
        {
          usuarioId,
          accion: 'PRODUCTO_MODIFICADO',
          entidad: 'producto',
          entidadId: id,
          antes,
          despues: aProducto(producto),
        },
        manager,
      );
    });
    // Si cambió el código, también se borra la clave del código viejo.
    await borrarCache(...clavesProducto(producto), ...clavesProducto(antes));
    return producto;
  }

  /** Cambio de precio. Regla: el precio anterior se queda en el historial. */
  async cambiarPrecio(id: string, datos: CambioPrecio, usuarioId: string): Promise<ProductoEntidad> {
    const producto = await this.productoActivo(id);
    const precioAnterior = producto.precio;
    const precioNuevo = dinero(datos.precio);

    // Si el precio nuevo es igual al actual, no tiene caso: se rechaza.
    if (precioNuevo.equals(precioAnterior)) {
      throw new ReglaDeNegocio(`El precio nuevo es igual al actual (${precioAnterior.toFixed(2)})`);
    }

    producto.precio = precioNuevo;
    producto.actualizadoEn = new Date();

    // Historial, producto y bitácora en una sola transacción.
    await conTransaccion(async (manager) => {
      await manager.insert(HistorialPrecioEntidad, {
        id: randomUUID(),
        productoId: id,
        precioAnterior,
        precioNuevo,
        fecha: producto.actualizadoEn,
        usuarioId,
      });
      await manager.save(producto);
      await this.bitacora.registrar(
        {
          usuarioId,
          accion: 'PRODUCTO_PRECIO',
          entidad: 'producto',
          entidadId: id,
          antes: { precio: precioAnterior.toFixed(2) },
          despues: { precio: precioNuevo.toFixed(2) },
        },
        manager,
      );
    });
    await borrarCache(...clavesProducto(producto));
    return producto;
  }

  /** Cambios de precio de un producto, del más viejo al más nuevo. */
  async historialPrecios(id: string): Promise<HistorialPrecioEntidad[]> {
    await this.productoActivo(id);
    return this.historial.find({ where: { productoId: id }, order: { fecha: 'ASC' } });
  }

  /**
   * Desactivar un producto. Regla: no se borra, porque las ventas viejas lo siguen necesitando para
   * tickets y reportes.
   */
  async desactivarProducto(id: string, usuarioId: string): Promise<ProductoEntidad> {
    const producto = await this.productoActivo(id);
    producto.activo = false;
    producto.desactivadoEn = new Date();
    producto.actualizadoEn = producto.desactivadoEn;

    await conTransaccion(async (manager) => {
      await manager.save(producto);
      await this.bitacora.registrar(
        {
          usuarioId,
          accion: 'PRODUCTO_DESACTIVADO',
          entidad: 'producto',
          entidadId: id,
          antes: { activo: true },
          despues: { activo: false },
        },
        manager,
      );
    });
    await borrarCache(...clavesProducto(producto));
    return producto;
  }

  async consultarProducto(id: string): Promise<ProductoEntidad> {
    const producto = await this.productoActivoPorId(id);
    if (!producto) throw new NoEncontrado('El producto no existe o está desactivado');
    return producto;
  }

  /** Búsqueda por código, la que se usa al escanear. */
  async buscarPorCodigo(codigo: string): Promise<ProductoEntidad> {
    const producto = await this.productoActivoPorCodigo(codigo);
    if (!producto) throw new NoEncontrado(`No existe un producto activo con el código ${codigo}`);
    return producto;
  }

  /**
   * Búsqueda de productos activos por categoría y por texto: el texto se busca en el nombre (sin
   * acentos) o al principio del código. El resultado va por páginas.
   */
  async listarProductos(
    consulta: ConsultaProductos,
  ): Promise<{ productos: ProductoEntidad[]; total: number }> {
    // Solo activos; los filtros se agregan si vienen.
    const qb = this.productos.createQueryBuilder('p').where('p.activo');

    if (consulta.categoriaId) {
      qb.andWhere('p.categoria_id = :categoriaId', { categoriaId: consulta.categoriaId });
    }
    if (consulta.buscar) {
      // textoLiteral evita que % o _ funcionen como comodines de LIKE.
      const texto = textoLiteral(normalizarTexto(consulta.buscar));
      qb.andWhere('(p.nombre_normalizado LIKE :parte OR lower(p.codigo) LIKE :inicio)', {
        parte: `%${texto}%`, // contiene el texto
        inicio: `${texto}%`, // empieza con el texto
      });
    }

    // Paginación: la página 2, de 20 en 20, se brinca los primeros 20.
    const [productos, total] = await qb
      .orderBy('p.nombre_normalizado', 'ASC')
      .addOrderBy('p.codigo', 'ASC')
      .skip((consulta.page - 1) * consulta.limit)
      .take(consulta.limit)
      .getManyAndCount();
    return { productos, total };
  }

  // Categorías

  async listarCategorias(): Promise<CategoriaEntidad[]> {
    return this.categorias.find({ order: { nombreNormalizado: 'ASC' } });
  }

  /** Alta de categoría; no se repiten nombres, sin importar acentos ni mayúsculas. */
  async registrarCategoria(datos: CategoriaNueva, usuarioId: string): Promise<CategoriaEntidad> {
    const existente = await this.categorias.findOneBy({ nombreNormalizado: normalizarTexto(datos.nombre) });
    if (existente) throw new Conflicto(`Ya existe la categoría ${existente.nombre}`);

    const categoria = this.categorias.create({
      id: randomUUID(),
      nombre: datos.nombre,
      nombreNormalizado: normalizarTexto(datos.nombre),
    });
    return conTransaccion(async (manager) => {
      await manager.save(categoria);
      await this.bitacora.registrar(
        {
          usuarioId,
          accion: 'CATEGORIA_REGISTRADA',
          entidad: 'categoria',
          entidadId: categoria.id,
          despues: { nombre: categoria.nombre },
        },
        manager,
      );
      return categoria;
    });
  }

  /** Borrar una categoría. Regla: solo si ya no tiene productos. */
  async eliminarCategoria(id: string, usuarioId: string): Promise<void> {
    const categoria = await this.categorias.findOneBy({ id });
    if (!categoria) throw new NoEncontrado('La categoría no existe');

    const productos = await this.productos.countBy({ categoriaId: id });
    if (productos > 0) {
      const cuantos = `${productos} ${productos === 1 ? 'producto' : 'productos'}`;
      throw new Conflicto(`La categoría ${categoria.nombre} tiene ${cuantos} y no se puede eliminar`);
    }

    await conTransaccion(async (manager) => {
      await manager.delete(CategoriaEntidad, { id });
      await this.bitacora.registrar(
        {
          usuarioId,
          accion: 'CATEGORIA_ELIMINADA',
          entidad: 'categoria',
          entidadId: id,
          antes: { nombre: categoria.nombre },
        },
        manager,
      );
    });
  }

  /** Precarga la caché con los productos activos (warm-up); regresa cuántos. */
  async precargarCache(): Promise<number> {
    const productos = await this.productos.findBy({ activo: true });
    for (const p of productos) await this.guardarEnCache(p);
    return productos.length;
  }

  // Para otros módulos (ventas): regresan null en lugar de lanzar error. Las dos primeras buscan
  // primero en la caché.

  /** Producto activo con ese código (sin importar mayúsculas), o null. */
  async productoActivoPorCodigo(codigo: string): Promise<ProductoEntidad | null> {
    const enCache = await leerCache<ProductoEnCache>(`producto:codigo:${codigo.toUpperCase()}`);
    if (enCache) return this.deCache(enCache);
    const producto = await this.productos
      .createQueryBuilder('p')
      .where('upper(p.codigo) = upper(:codigo)', { codigo })
      .andWhere('p.activo')
      .getOne();
    if (producto) await this.guardarEnCache(producto);
    return producto;
  }

  async productoActivoPorId(id: string): Promise<ProductoEntidad | null> {
    const enCache = await leerCache<ProductoEnCache>(`producto:id:${id}`);
    if (enCache) return this.deCache(enCache);
    const producto = await this.productos.findOneBy({ id, activo: true });
    if (producto) await this.guardarEnCache(producto);
    return producto;
  }

  /** Incluye desactivados; los necesitan las ventas canceladas y los reportes. */
  async productoPorId(id: string): Promise<ProductoEntidad | null> {
    return this.productos.findOneBy({ id });
  }

  // Revisiones de adentro

  /**
   * Busca un producto activo directo en PostgreSQL, no en la caché, porque se usa justo antes de
   * modificarlo; si no existe, responde 404.
   */
  private async productoActivo(id: string): Promise<ProductoEntidad> {
    const producto = await this.productos.findOneBy({ id, activo: true });
    if (!producto) throw new NoEncontrado('El producto no existe o está desactivado');
    return producto;
  }

  /**
   * Revisa que ningún otro producto use el código, contando los desactivados. idPropio deja que un
   * producto conserve su código al modificarlo.
   */
  private async validarCodigoLibre(codigo: string, idPropio?: string): Promise<void> {
    const existente = await this.productos
      .createQueryBuilder('p')
      .where('upper(p.codigo) = upper(:codigo)', { codigo })
      .getOne();
    if (existente && existente.id !== idPropio) {
      const estado = existente.activo ? '' : ' (producto desactivado)';
      throw new Conflicto(`El código ${codigo} ya pertenece a ${existente.nombre}${estado}`);
    }
  }

  private async guardarEnCache(p: ProductoEntidad): Promise<void> {
    const valor: ProductoEnCache = { ...aProducto(p), nombreNormalizado: p.nombreNormalizado };
    for (const nombre of clavesProducto(p)) await guardarCache(nombre, valor, SEGUNDOS_CACHE);
  }

  /** Convierte lo que hay en la caché (montos y fechas como texto) en la entidad. */
  private deCache(c: ProductoEnCache): ProductoEntidad {
    return this.productos.create({
      ...c,
      precio: dinero(c.precio),
      costo: dinero(c.costo),
      existenciaMinima: peso(c.existenciaMinima),
      creadoEn: new Date(c.creadoEn),
      actualizadoEn: new Date(c.actualizadoEn),
      desactivadoEn: null,
    });
  }

  private async validarCategoria(categoriaId: string): Promise<void> {
    if (!(await this.categorias.existsBy({ id: categoriaId }))) {
      throw new ReglaDeNegocio('La categoría indicada no existe');
    }
  }
}

// --- Rutas ---
// Cada ruta pasa por autenticar (401), autorizar (403) y validar (400) antes de llegar a las reglas.
// Regla: solo el Dueño puede modificar el catálogo.

export function rutasCatalogo(): Router {
  const router = Router();
  const catalogo = new CatalogoServicio();
  const inventario = new InventarioServicio();

  /** Le agrega a cada producto su existencia (la suma de sus lotes) para avisar si no hay. */
  async function conExistencia(productos: ProductoEntidad[]) {
    const existencias = await inventario.existencias(productos.map((p) => p.id));
    return productos.map((p) => ({ ...aProducto(p), existencia: existencias.get(p.id)!.toFixed(2) }));
  }

  // Consultas (Dueño y Empleado)

  // GET /productos?buscar=coca&page=1&limit=20
  router.get(
    '/productos',
    autenticar,
    autorizar('producto:consultar'),
    validar({ query: esquemaConsultaProductos }),
    async (req, res) => {
      const consulta = datos<ConsultaProductos>(req, 'query');
      const { productos, total } = await catalogo.listarProductos(consulta);
      const mensaje = total === 1 ? '1 producto encontrado' : `${total} productos encontrados`;
      const meta = paginacion(consulta.page, consulta.limit, total);
      responder(res, await conExistencia(productos), mensaje, 200, meta);
    },
  );

  // GET /productos/codigo/:codigo (al escanear). Va antes de /productos/:id para que "codigo" no
  // se confunda con un id.
  router.get(
    '/productos/codigo/:codigo',
    autenticar,
    autorizar('producto:consultar'),
    validar({ params: esquemaCodigo }),
    async (req, res) => {
      const { codigo } = datos<{ codigo: string }>(req, 'params');
      const [producto] = await conExistencia([await catalogo.buscarPorCodigo(codigo)]);
      responder(res, producto, 'Producto encontrado');
    },
  );

  // GET /productos/:id → un producto
  router.get(
    '/productos/:id',
    autenticar,
    autorizar('producto:consultar'),
    validar({ params: esquemaId }),
    async (req, res) => {
      const { id } = datos<{ id: string }>(req, 'params');
      const [producto] = await conExistencia([await catalogo.consultarProducto(id)]);
      responder(res, producto, 'Producto encontrado');
    },
  );

  // GET /productos/:id/precios → historial de precios
  router.get(
    '/productos/:id/precios',
    autenticar,
    autorizar('producto:consultar'),
    validar({ params: esquemaId }),
    async (req, res) => {
      const { id } = datos<{ id: string }>(req, 'params');
      const historial = await catalogo.historialPrecios(id);
      const respuesta = historial.map((h) => ({
        precioAnterior: h.precioAnterior.toFixed(2),
        precioNuevo: h.precioNuevo.toFixed(2),
        fecha: h.fecha.toISOString(),
        usuarioId: h.usuarioId,
      }));
      responder(res, respuesta, 'Historial de precios');
    },
  );

  // GET /categorias → lista de categorías
  router.get('/categorias', autenticar, autorizar('producto:consultar'), async (_req, res) => {
    const categorias = await catalogo.listarCategorias();
    responder(
      res,
      categorias.map((c) => ({ id: c.id, nombre: c.nombre })),
      'Categorías',
    );
  });

  // Cambios (solo Dueño)

  // POST /productos → alta (201); el usuario de la sesión queda en la bitácora.
  router.post(
    '/productos',
    autenticar,
    autorizar('producto:crear'),
    validar({ body: esquemaProductoNuevo }),
    async (req, res) => {
      const producto = await catalogo.registrarProducto(
        datos<ProductoNuevo>(req, 'body'),
        sesionDe(req).usuarioId,
      );
      responder(res, aProducto(producto), 'Producto registrado', 201);
    },
  );

  // PUT /productos/:id → modificar datos (sin precio)
  router.put(
    '/productos/:id',
    autenticar,
    autorizar('producto:modificar'),
    validar({ params: esquemaId, body: esquemaProductoModificado }),
    async (req, res) => {
      const { id } = datos<{ id: string }>(req, 'params');
      const cambios = datos<ProductoModificado>(req, 'body');
      const producto = await catalogo.modificarProducto(id, cambios, sesionDe(req).usuarioId);
      responder(res, aProducto(producto), 'Producto modificado');
    },
  );

  // PATCH /productos/:id/precio → cambiar solo el precio
  router.patch(
    '/productos/:id/precio',
    autenticar,
    autorizar('producto:precio'),
    validar({ params: esquemaId, body: esquemaCambioPrecio }),
    async (req, res) => {
      const { id } = datos<{ id: string }>(req, 'params');
      const nuevo = datos<CambioPrecio>(req, 'body');
      const producto = await catalogo.cambiarPrecio(id, nuevo, sesionDe(req).usuarioId);
      responder(res, aProducto(producto), 'Precio actualizado');
    },
  );

  // DELETE /productos/:id → desactivar
  router.delete(
    '/productos/:id',
    autenticar,
    autorizar('producto:desactivar'),
    validar({ params: esquemaId }),
    async (req, res) => {
      const { id } = datos<{ id: string }>(req, 'params');
      const producto = await catalogo.desactivarProducto(id, sesionDe(req).usuarioId);
      responder(res, aProducto(producto), 'Producto desactivado');
    },
  );

  // POST /categorias → crear categoría
  router.post(
    '/categorias',
    autenticar,
    autorizar('categoria:crear'),
    validar({ body: esquemaCategoriaNueva }),
    async (req, res) => {
      const categoria = await catalogo.registrarCategoria(
        datos<CategoriaNueva>(req, 'body'),
        sesionDe(req).usuarioId,
      );
      responder(res, { id: categoria.id, nombre: categoria.nombre }, 'Categoría registrada', 201);
    },
  );

  // DELETE /categorias/:id → eliminar categoría vacía
  router.delete(
    '/categorias/:id',
    autenticar,
    autorizar('categoria:eliminar'),
    validar({ params: esquemaId }),
    async (req, res) => {
      const { id } = datos<{ id: string }>(req, 'params');
      await catalogo.eliminarCategoria(id, sesionDe(req).usuarioId);
      responder(res, null, 'Categoría eliminada');
    },
  );

  return router;
}

// --- Swagger ---

export function documentarCatalogo(registro: OpenAPIRegistry): void {
  const etiqueta = 'Catálogo';
  documentar(registro, [
    {
      metodo: 'get',
      ruta: '/productos',
      resumen: 'Listar o buscar productos activos por nombre o código',
      etiqueta,
      permiso: 'producto:consultar',
      query: esquemaConsultaProductos,
      respuesta: z.array(esquemaProductoConExistencia),
      paginada: true,
    },
    {
      metodo: 'get',
      ruta: '/productos/codigo/:codigo',
      resumen: 'Buscar un producto activo por su código (al escanear)',
      etiqueta,
      permiso: 'producto:consultar',
      params: esquemaCodigo,
      respuesta: esquemaProductoConExistencia,
      errores: [404],
    },
    {
      metodo: 'get',
      ruta: '/productos/:id',
      resumen: 'Consultar un producto activo',
      etiqueta,
      permiso: 'producto:consultar',
      params: esquemaId,
      respuesta: esquemaProductoConExistencia,
      errores: [404],
    },
    {
      metodo: 'post',
      ruta: '/productos',
      resumen: 'Registrar producto',
      etiqueta,
      permiso: 'producto:crear',
      body: esquemaProductoNuevo,
      respuesta: esquemaProducto,
      estado: 201,
      errores: [409, 422],
    },
    {
      metodo: 'put',
      ruta: '/productos/:id',
      resumen: 'Modificar producto, excepto el precio',
      etiqueta,
      permiso: 'producto:modificar',
      params: esquemaId,
      body: esquemaProductoModificado,
      respuesta: esquemaProducto,
      errores: [404, 409, 422],
    },
    {
      metodo: 'patch',
      ruta: '/productos/:id/precio',
      resumen: 'Cambiar el precio y guardar el historial',
      etiqueta,
      permiso: 'producto:precio',
      params: esquemaId,
      body: esquemaCambioPrecio,
      respuesta: esquemaProducto,
      errores: [404, 422],
    },
    {
      metodo: 'get',
      ruta: '/productos/:id/precios',
      resumen: 'Consultar el historial de precios',
      etiqueta,
      permiso: 'producto:consultar',
      params: esquemaId,
      respuesta: z.array(esquemaHistorialPrecio),
      errores: [404],
    },
    {
      metodo: 'delete',
      ruta: '/productos/:id',
      resumen: 'Desactivar un producto sin borrarlo',
      etiqueta,
      permiso: 'producto:desactivar',
      params: esquemaId,
      respuesta: esquemaProducto,
      errores: [404],
    },
    {
      metodo: 'get',
      ruta: '/categorias',
      resumen: 'Listar categorías',
      etiqueta,
      permiso: 'producto:consultar',
      respuesta: z.array(esquemaCategoria),
    },
    {
      metodo: 'post',
      ruta: '/categorias',
      resumen: 'Registrar categoría',
      etiqueta,
      permiso: 'categoria:crear',
      body: esquemaCategoriaNueva,
      respuesta: esquemaCategoria,
      estado: 201,
      errores: [409],
    },
    {
      metodo: 'delete',
      ruta: '/categorias/:id',
      resumen: 'Eliminar una categoría sin productos',
      etiqueta,
      permiso: 'categoria:eliminar',
      params: esquemaId,
      errores: [404, 409],
    },
  ]);
}
