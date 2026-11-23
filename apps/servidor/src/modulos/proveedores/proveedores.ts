/**
 * Módulo proveedores: a quién se le compra. Solo el Dueño da de alta proveedores; Dueño y Empleado los
 * consultan al capturar una entrada de mercancía.
 * La entidad está en proveedores.tablas.ts.
 */
import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import {
  esquemaProveedor,
  esquemaProveedorNuevo,
  normalizarTexto,
  type Proveedor,
  type ProveedorNuevo,
} from '@pos/compartido';
import { documentar } from '../../comun/documentar';
import { Conflicto } from '../../comun/errores';
import { responder } from '../../comun/respuesta';
import { autenticar, autorizar } from '../../comun/seguridad';
import { sesionDe } from '../../comun/sesion';
import { datos, validar } from '../../comun/validar';
import { fuenteDatos } from '../../infraestructura/base-datos/fuente';
import { conTransaccion } from '../../infraestructura/base-datos/transaccion';
import { BitacoraServicio } from '../bitacora/bitacora';
import { ProveedorEntidad } from './proveedores.tablas';

/** Proveedor en el formato de la respuesta. */
function aProveedor(p: ProveedorEntidad): Proveedor {
  return { id: p.id, nombre: p.nombre, telefono: p.telefono, creadoEn: p.creadoEn.toISOString() };
}

// --- Reglas ---

export class ProveedoresServicio {
  private proveedores = fuenteDatos.getRepository(ProveedorEntidad);
  private bitacora = new BitacoraServicio();

  /** Proveedores en orden alfabético. */
  async listar(): Promise<ProveedorEntidad[]> {
    return this.proveedores.find({ order: { nombreNormalizado: 'ASC' } });
  }

  /** Alta de proveedor; no se repiten nombres, sin importar acentos ni mayúsculas. */
  async registrar(datos: ProveedorNuevo, usuarioId: string): Promise<ProveedorEntidad> {
    const nombreNormalizado = normalizarTexto(datos.nombre);
    const existente = await this.proveedores.findOneBy({ nombreNormalizado });
    if (existente) throw new Conflicto(`Ya existe el proveedor ${existente.nombre}`);

    const proveedor = this.proveedores.create({
      id: randomUUID(),
      nombre: datos.nombre,
      nombreNormalizado,
      telefono: datos.telefono,
      creadoEn: new Date(),
      creadoPor: usuarioId,
    });
    return conTransaccion(async (manager) => {
      await manager.save(proveedor);
      await this.bitacora.registrar(
        {
          usuarioId,
          accion: 'PROVEEDOR_REGISTRADO',
          entidad: 'proveedor',
          entidadId: proveedor.id,
          despues: { nombre: proveedor.nombre, telefono: proveedor.telefono },
        },
        manager,
      );
      return proveedor;
    });
  }

  /** Para el módulo de inventario: el proveedor con ese id, o null. */
  async porId(id: string): Promise<ProveedorEntidad | null> {
    return this.proveedores.findOneBy({ id });
  }
}

// --- Rutas ---

export function rutasProveedores(): Router {
  const router = Router();
  const servicio = new ProveedoresServicio();

  // GET /proveedores (Dueño y Empleado, para capturar entradas)
  router.get('/proveedores', autenticar, autorizar('inventario:entrada'), async (_req, res) => {
    const proveedores = await servicio.listar();
    responder(res, proveedores.map(aProveedor), `${proveedores.length} proveedores`);
  });

  // POST /proveedores (solo Dueño)
  router.post(
    '/proveedores',
    autenticar,
    autorizar('proveedor:crear'),
    validar({ body: esquemaProveedorNuevo }),
    async (req, res) => {
      const proveedor = await servicio.registrar(datos<ProveedorNuevo>(req, 'body'), sesionDe(req).usuarioId);
      responder(res, aProveedor(proveedor), 'Proveedor registrado', 201);
    },
  );

  return router;
}

// --- Swagger ---

export function documentarProveedores(registro: OpenAPIRegistry): void {
  const etiqueta = 'Proveedores';
  documentar(registro, [
    {
      metodo: 'get',
      ruta: '/proveedores',
      resumen: 'Listar proveedores',
      etiqueta,
      permiso: 'inventario:entrada',
      respuesta: z.array(esquemaProveedor),
    },
    {
      metodo: 'post',
      ruta: '/proveedores',
      resumen: 'Registrar un proveedor',
      etiqueta,
      permiso: 'proveedor:crear',
      body: esquemaProveedorNuevo,
      respuesta: esquemaProveedor,
      estado: 201,
      errores: [409],
    },
  ]);
}
