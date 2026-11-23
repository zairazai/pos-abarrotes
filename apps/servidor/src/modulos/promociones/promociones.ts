/**
 * Módulo promociones: mayoreo, NxM (2x1, 3x2) o precio especial de un producto, por días. Solo el
 * Dueño las configura y, como regla, el mismo producto no puede tener dos con fechas que se encimen;
 * además de revisarlo aquí, la base lo impide con una restricción EXCLUDE.
 * Al cobrar, una promoción aplica según sus fechas; el worker solo mantiene al día el estado guardado
 * y avisa (conciliar). La entidad está en promociones.tablas.ts.
 */
import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { LessThanOrEqual, MoreThanOrEqual, Not, QueryFailedError } from 'typeorm';
import { z } from 'zod';
import {
  Decimal,
  esquemaConsultaPromociones,
  esquemaPromocion,
  esquemaPromocionNueva,
  estadoPromocion,
  revisarPromocion,
  textoPromocion,
  type ConsultaPromociones,
  type Promocion,
  type PromocionNueva,
  type ReglaPromocion,
} from '@pos/compartido';
import { documentar } from '../../comun/documentar';
import { Conflicto, ReglaDeNegocio } from '../../comun/errores';
import { fechaLocal } from '../../comun/fechas';
import { responder } from '../../comun/respuesta';
import { autenticar, autorizar } from '../../comun/seguridad';
import { sesionDe } from '../../comun/sesion';
import { emitir } from '../../comun/tiempo-real';
import { datos, validar } from '../../comun/validar';
import { fuenteDatos } from '../../infraestructura/base-datos/fuente';
import { borrarCache, guardarCache, leerCache } from '../../infraestructura/cache';
import { conTransaccion } from '../../infraestructura/base-datos/transaccion';
import { BitacoraServicio } from '../bitacora/bitacora';
import { CatalogoServicio } from '../catalogo/catalogo';
import { ConfiguracionServicio } from '../configuracion/configuracion';
import { NotificacionesServicio } from '../notificaciones/notificaciones';
import { ProductoEntidad } from '../catalogo/catalogo.tablas';
import { PromocionEntidad } from './promociones.tablas';

/** Promoción con su producto, para la respuesta. */
interface DetallePromocion {
  promocion: PromocionEntidad;
  producto: ProductoEntidad;
}

/** Promoción que aplica hoy a un producto. */
export interface PromocionVigente {
  id: string;
  productoId: string;
  regla: ReglaPromocion;
}

/** Las vigentes de un día se guardan en la caché; el día va en la clave. */
const claveVigentes = (dia: string) => `promociones:vigentes:${dia}`;
const SEGUNDOS_CACHE = 3600;

/** Condiciones de la promoción como las usa el paquete compartido. */
function reglaDe(p: PromocionNueva | PromocionEntidad): ReglaPromocion {
  if (p.tipo === 'MAYOREO') {
    return { tipo: 'MAYOREO', cantidadMinima: p.cantidadMinima!.toString(), precio: p.precio!.toString() };
  }
  if (p.tipo === 'NXM') return { tipo: 'NXM', lleva: p.lleva!, paga: p.paga! };
  return { tipo: 'PRECIO_ESPECIAL', precio: p.precio!.toString() };
}

// --- Reglas ---

export class PromocionesServicio {
  private promociones = fuenteDatos.getRepository(PromocionEntidad);
  private catalogo = new CatalogoServicio();
  private configuracion = new ConfiguracionServicio();
  private notificaciones = new NotificacionesServicio();
  private bitacora = new BitacoraServicio();

  /** Alta de promoción: revisa sus condiciones y que no se encime con otra. */
  async registrar(datos: PromocionNueva, usuarioId: string): Promise<DetallePromocion> {
    const producto = await this.catalogo.productoActivoPorId(datos.productoId);
    if (!producto) throw new ReglaDeNegocio('El producto no existe o está desactivado');
    const hoy = fechaLocal(new Date());
    try {
      revisarPromocion(reglaDe(datos), producto, datos.inicio, hoy);
    } catch (error) {
      if (error instanceof RangeError) throw new ReglaDeNegocio(error.message);
      throw error;
    }

    // Se enciman si una empieza antes de que termine la otra y termina después de que la otra empiece.
    const cruzada = await this.promociones.findOneBy({
      productoId: producto.id,
      inicio: LessThanOrEqual(datos.fin),
      fin: MoreThanOrEqual(datos.inicio),
    });
    if (cruzada) throw this.traslape(producto, cruzada);

    const promocion = this.promociones.create({
      id: randomUUID(),
      productoId: producto.id,
      tipo: datos.tipo,
      cantidadMinima: datos.tipo === 'MAYOREO' ? new Decimal(datos.cantidadMinima) : null,
      precio: datos.tipo === 'NXM' ? null : new Decimal(datos.precio),
      lleva: datos.tipo === 'NXM' ? datos.lleva : null,
      paga: datos.tipo === 'NXM' ? datos.paga : null,
      inicio: datos.inicio,
      fin: datos.fin,
      estado: estadoPromocion(datos.inicio, datos.fin, hoy),
      creadaPor: usuarioId,
      creadaEn: new Date(),
    });

    try {
      await conTransaccion(async (manager) => {
        await manager.insert(PromocionEntidad, promocion);
        await this.bitacora.registrar(
          {
            usuarioId,
            accion: 'PROMOCION_REGISTRADA',
            entidad: 'promocion',
            entidadId: promocion.id,
            despues: { producto: producto.nombre, ...datos },
          },
          manager,
        );
      });
      await borrarCache(claveVigentes(hoy));
    } catch (error) {
      // Dos altas al mismo tiempo con fechas encimadas: la restricción EXCLUDE deja pasar solo una (23P01).
      if (error instanceof QueryFailedError && (error.driverError as { code?: string }).code === '23P01') {
        const otra = await this.promociones.findOneBy({
          productoId: producto.id,
          inicio: LessThanOrEqual(datos.fin),
          fin: MoreThanOrEqual(datos.inicio),
        });
        throw this.traslape(producto, otra!);
      }
      throw error;
    }
    await this.difundir(promocion, producto);
    return { promocion, producto };
  }

  /** Avisa a los clientes en cuanto se crea; si el aviso falla, la promoción ya quedó guardada igual. */
  private async difundir(promocion: PromocionEntidad, producto: ProductoEntidad): Promise<void> {
    try {
      const { nombre: tienda } = await this.configuracion.datosTienda();
      await this.notificaciones.difundirPromocion(
        `Promoción en ${tienda}`,
        textoPromocion({
          tienda,
          producto: producto.nombre,
          regla: reglaDe(promocion),
          inicio: promocion.inicio,
          fin: promocion.fin,
        }),
      );
    } catch (error) {
      console.error(`No se pudo difundir la promoción: ${(error as Error).message}`);
    }
  }

  /**
   * Promociones que aplican hoy, por producto. Se decide con las fechas, así aplican aunque el worker
   * esté apagado.
   */
  async vigentes(): Promise<Map<string, PromocionVigente>> {
    const hoy = fechaLocal(new Date());
    let lista = await leerCache<PromocionVigente[]>(claveVigentes(hoy));
    if (!lista) {
      const promociones = await this.promociones.findBy({
        inicio: LessThanOrEqual(hoy),
        fin: MoreThanOrEqual(hoy),
      });
      lista = promociones.map((p) => ({ id: p.id, productoId: p.productoId, regla: reglaDe(p) }));
      await guardarCache(claveVigentes(hoy), lista, SEGUNDOS_CACHE);
    }
    return new Map(lista.map((p) => [p.productoId, p]));
  }

  /**
   * Pone el estado guardado de acuerdo con las fechas y apunta cada cambio. Si ya está al día no hace
   * nada, así sirve a diario y al arrancar (por lo que haya pasado con la PC apagada). Regresa cuántas
   * cambiaron.
   */
  async conciliar(): Promise<number> {
    const hoy = fechaLocal(new Date());
    const promociones = await this.promociones.findBy({ estado: Not('VENCIDA') });
    const cambios = promociones.filter((p) => p.estado !== estadoPromocion(p.inicio, p.fin, hoy));
    for (const p of cambios) {
      const estado = estadoPromocion(p.inicio, p.fin, hoy);
      await conTransaccion(async (manager) => {
        await manager.update(PromocionEntidad, p.id, { estado });
        await this.bitacora.registrar(
          {
            usuarioId: null,
            accion: estado === 'ACTIVA' ? 'PROMOCION_ACTIVADA' : 'PROMOCION_VENCIDA',
            entidad: 'promocion',
            entidadId: p.id,
            antes: { estado: p.estado },
            despues: { estado },
          },
          manager,
        );
      });
    }
    return cambios.length;
  }

  /** Promociones de la más nueva a la más vieja por fecha de inicio; se puede filtrar por estado. */
  async listar(consulta: ConsultaPromociones): Promise<DetallePromocion[]> {
    const hoy = fechaLocal(new Date());
    const promociones = await this.promociones.find({ order: { inicio: 'DESC', creadaEn: 'DESC' } });
    const filtradas = consulta.estado
      ? promociones.filter((p) => estadoPromocion(p.inicio, p.fin, hoy) === consulta.estado)
      : promociones;
    const productos = await Promise.all(filtradas.map((p) => this.catalogo.productoPorId(p.productoId)));
    return filtradas.map((promocion, i) => ({ promocion, producto: productos[i]! }));
  }

  private traslape(producto: ProductoEntidad, otra: PromocionEntidad): Conflicto {
    return new Conflicto(`${producto.nombre} ya tiene una promoción del ${otra.inicio} al ${otra.fin}`);
  }
}

/** Promoción en el formato de la respuesta; el estado sale de las fechas de hoy. */
function aPromocion({ promocion: p, producto }: DetallePromocion): Promocion {
  return {
    id: p.id,
    producto: {
      id: producto.id,
      nombre: producto.nombre,
      unidad: producto.unidad,
      precio: producto.precio.toFixed(2),
    },
    tipo: p.tipo,
    cantidadMinima: p.cantidadMinima?.toFixed(2) ?? null,
    precio: p.precio?.toFixed(2) ?? null,
    lleva: p.lleva,
    paga: p.paga,
    inicio: p.inicio,
    fin: p.fin,
    estado: estadoPromocion(p.inicio, p.fin, fechaLocal(new Date())),
    creadaPor: p.creadaPor,
    creadaEn: p.creadaEn.toISOString(),
  };
}

// --- Rutas ---
// Dueño y Empleado las consultan. Regla: solo el Dueño las configura.

export function rutasPromociones(): Router {
  const router = Router();
  const servicio = new PromocionesServicio();

  // GET /promociones?estado=ACTIVA
  router.get(
    '/promociones',
    autenticar,
    autorizar('producto:consultar'),
    validar({ query: esquemaConsultaPromociones }),
    async (req, res) => {
      const promociones = await servicio.listar(datos<ConsultaPromociones>(req, 'query'));
      responder(res, promociones.map(aPromocion), `${promociones.length} promociones`);
    },
  );

  // POST /promociones  { productoId, tipo, condiciones..., inicio, fin }
  router.post(
    '/promociones',
    autenticar,
    autorizar('promocion:configurar'),
    validar({ body: esquemaPromocionNueva }),
    async (req, res) => {
      const detalle = await servicio.registrar(datos<PromocionNueva>(req, 'body'), sesionDe(req).usuarioId);
      if (detalle.promocion.estado === 'ACTIVA') emitir('promocion:cambio');
      responder(res, aPromocion(detalle), 'Promoción registrada', 201);
    },
  );

  return router;
}

// --- Swagger ---

export function documentarPromociones(registro: OpenAPIRegistry): void {
  const etiqueta = 'Promociones';
  documentar(registro, [
    {
      metodo: 'get',
      ruta: '/promociones',
      resumen: 'Consultar las promociones con su estado: programada, activa o vencida',
      etiqueta,
      permiso: 'producto:consultar',
      query: esquemaConsultaPromociones,
      respuesta: z.array(esquemaPromocion),
    },
    {
      metodo: 'post',
      ruta: '/promociones',
      resumen:
        'Registrar una promoción de mayoreo, NxM o precio especial por días; no se traslapa con otra del mismo producto',
      etiqueta,
      permiso: 'promocion:configurar',
      body: esquemaPromocionNueva,
      respuesta: esquemaPromocion,
      estado: 201,
      errores: [409, 422],
    },
  ]);
}
