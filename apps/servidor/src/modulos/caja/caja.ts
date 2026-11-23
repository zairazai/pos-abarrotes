/**
 * Módulo caja: apertura, retiros e ingresos, arqueo y cierre del día.
 * - La caja abre con el efectivo que quedó en el cierre anterior; el primer día el Dueño cuenta el fondo.
 * - Las ventas en efectivo se suman solas (las registra ventas).
 * - Si el arqueo no cuadra se cuenta otra vez y, si sigue sin cuadrar, se cierra con justificación.
 * - Arqueo a ciegas (regla de la tienda): el Empleado no ve cuánto debería haber; el Dueño sí.
 */
import { randomUUID } from 'node:crypto';
import { Router, type Request } from 'express';
import { QueryFailedError, type EntityManager } from 'typeorm';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import {
  DENOMINACIONES,
  Decimal,
  efectivoEsperado,
  esquemaApertura,
  esquemaArqueo,
  esquemaCaja,
  esquemaCajaAbierta,
  esquemaCajaActual,
  esquemaCierre,
  esquemaMovimiento,
  esquemaMovimientoNuevo,
  esquemaResultadoArqueo,
  evaluarArqueo,
  revisarEfectivoParaPago,
  tienePermiso,
  totalConteo,
  type Apertura,
  type ArqueoNuevo,
  type Caja,
  type CajaActual,
  type Cierre,
  type ConteoEfectivo,
  type MovimientoEfectivo,
  type MovimientoNuevo,
  type ResultadoDeArqueo,
  type ResumenAlertas,
  type Rol,
  type TipoEfectivo,
  type VentaAbierta,
} from '@pos/compartido';
import { documentar } from '../../comun/documentar';
import { Conflicto, Prohibido, ReglaDeNegocio } from '../../comun/errores';
import { fechaLocal } from '../../comun/fechas';
import { responder } from '../../comun/respuesta';
import { autenticar, autorizar } from '../../comun/seguridad';
import { sesionDe } from '../../comun/sesion';
import { datos, validar } from '../../comun/validar';
import { fuenteDatos } from '../../infraestructura/base-datos/fuente';
import { conTransaccion } from '../../infraestructura/base-datos/transaccion';
import { BitacoraServicio } from '../bitacora/bitacora';
import { RespaldosServicio } from '../respaldos/respaldos';
import {
  ArqueoDenominacionEntidad,
  ArqueoEntidad,
  CajaEntidad,
  MovimientoEfectivoEntidad,
} from './caja.tablas';

/** Caja con los datos que se muestran en pantalla. */
export interface DetalleCaja {
  caja: CajaEntidad;
  movimientos: MovimientoEfectivoEntidad[]; // retiros, ingresos y pagos a proveedor
  ventasEfectivo: Decimal;
  ultimoArqueo: ArqueoEntidad | null;
  esperado: Decimal;
}

/** Respuesta de GET /caja/actual. */
export interface EstadoCaja {
  detalle: DetalleCaja | null; // la caja abierta, o la de hoy
  cajaDeOtroDia: boolean; // se quedó abierta la de un día anterior
  requiereFondoInicial: boolean; // todavía no existe ninguna caja
  fondoPropuesto: Decimal | null;
}

// Regla: al cerrar se cancelan las ventas que no se cobraron. Pero eso le toca a ventas, que ya
// depende de caja. Para no hacer un círculo de importaciones, caja define la interfaz
// ParticipanteCierre, ventas la cumple y app.ts la apunta al arrancar.

export interface ParticipanteCierre {
  /** Cancela las ventas abiertas dentro de la transacción del cierre y regresa cuántas fueron. */
  cancelarVentasAbiertas(manager: EntityManager, cajaId: string, ventas: VentaAbierta[]): Promise<number>;
  /** Le manda al Dueño el resumen del día, ya con la caja cerrada. */
  alCerrarCaja(caja: CajaEntidad): Promise<void>;
}

let participante: ParticipanteCierre | null = null;

/** Se llama desde app.ts con el servicio de ventas. */
export function registrarParticipanteCierre(p: ParticipanteCierre): void {
  participante = p;
}

function participanteCierre(): ParticipanteCierre {
  if (!participante) throw new Error('No hay quién cancele las ventas abiertas al cerrar la caja');
  return participante;
}

// Lo mismo con el resumen de alertas al abrir: lo calcula inventario, que ya depende de caja, y
// app.ts lo apunta.

export interface ProveedorAlertas {
  resumenAlertas(): Promise<ResumenAlertas>;
}

let proveedorAlertas: ProveedorAlertas | null = null;

/** Se llama desde app.ts con el servicio de inventario. */
export function registrarProveedorAlertas(p: ProveedorAlertas): void {
  proveedorAlertas = p;
}

/**
 * Resumen de alertas para la respuesta de la apertura. Si falla, no pasa nada grave: la caja ya quedó
 * abierta y se puede vender. Se regresa null y las alertas se consultan en GET /inventario/alertas.
 */
async function alertasAlAbrir(): Promise<ResumenAlertas | null> {
  try {
    if (!proveedorAlertas) throw new Error('nadie calcula las alertas');
    return await proveedorAlertas.resumenAlertas();
  } catch (error) {
    console.error(`No se pudo calcular el resumen de alertas: ${(error as Error).message}`);
    return null;
  }
}

// --- Reglas ---
// Cada operación se guarda junto con su registro en la bitácora, en una sola transacción.

export class CajaServicio {
  private cajas = fuenteDatos.getRepository(CajaEntidad);
  private movimientos = fuenteDatos.getRepository(MovimientoEfectivoEntidad);
  private arqueos = fuenteDatos.getRepository(ArqueoEntidad);
  private bitacora = new BitacoraServicio();

  /** Estado de la caja: la abierta (o la de hoy) y lo que falta para poder abrir. */
  async actual(): Promise<EstadoCaja> {
    const hoy = fechaLocal(new Date());
    const abierta = await this.cajas.findOneBy({ estado: 'ABIERTA' });
    // Si no hay caja abierta, se enseña la de hoy ya cerrada, si existe.
    const caja = abierta ?? (await this.cajas.findOneBy({ fecha: hoy }));
    const anterior = abierta ? null : await this.ultimaCerrada();
    return {
      detalle: caja ? await this.detalle(caja) : null,
      cajaDeOtroDia: !!abierta && abierta.fecha !== hoy,
      requiereFondoInicial: (await this.cajas.count()) === 0,
      fondoPropuesto: anterior?.efectivoFinal ?? null,
    };
  }

  /** Apertura. Regla: una sola caja abierta a la vez y una por día. */
  async abrir(datos: Apertura, usuarioId: string, rol: Rol): Promise<DetalleCaja> {
    const hoy = fechaLocal(new Date());

    const abierta = await this.cajas.findOneBy({ estado: 'ABIERTA' });
    if (abierta) {
      throw new Conflicto(
        abierta.fecha === hoy
          ? 'La caja de hoy ya está abierta'
          : `La caja del ${abierta.fecha} sigue abierta; haga su arqueo y ciérrela antes de abrir la de hoy`,
      );
    }
    // La de hoy ya se abrió y ya se cerró.
    if (await this.cajas.existsBy({ fecha: hoy })) {
      throw new Conflicto('La caja de hoy ya se cerró; solo hay una caja por día');
    }

    let fondoInicial: Decimal;
    let conteoFondo: ConteoEfectivo | null = null;
    const anterior = await this.ultimaCerrada();

    if (anterior) {
      // Regla: abre con lo que quedó en el cierre anterior; no se acepta otro fondo.
      if (datos.fondoInicial) {
        throw new ReglaDeNegocio(
          'El fondo por denominación solo se captura en el primer uso; el fondo es el efectivo del cierre anterior',
        );
      }
      fondoInicial = anterior.efectivoFinal!;
    } else {
      // Primer día: solo el Dueño captura el conteo del fondo.
      if (!tienePermiso(rol, 'caja:fondo_inicial')) {
        throw new Prohibido('Es el primer uso del sistema: el Dueño debe capturar el fondo inicial');
      }
      if (!datos.fondoInicial) {
        throw new ReglaDeNegocio('Es el primer uso del sistema: capture el fondo inicial por denominación');
      }
      fondoInicial = totalConteo(datos.fondoInicial);
      conteoFondo = datos.fondoInicial;
    }

    const caja = this.cajas.create({
      id: randomUUID(),
      fecha: hoy,
      estado: 'ABIERTA',
      fondoInicial,
      conteoFondo,
      abiertaPor: usuarioId,
      abiertaEn: new Date(),
      cerradaPor: null,
      cerradaEn: null,
      efectivoFinal: null,
      diferencia: null,
      justificacion: null,
    });

    await this.guardarSinDuplicar('Otra persona abrió la caja al mismo tiempo; consulte la caja actual', () =>
      conTransaccion(async (manager) => {
        await manager.insert(CajaEntidad, caja);
        await this.bitacora.registrar(
          {
            usuarioId,
            accion: 'CAJA_ABIERTA',
            entidad: 'caja',
            entidadId: caja.id,
            despues: { fecha: caja.fecha, fondoInicial: fondoInicial.toFixed(2), primerUso: !anterior },
          },
          manager,
        );
      }),
    );
    return this.detalle(caja);
  }

  /** Retiro o ingreso de efectivo. Los retiros no se comparan contra el esperado. */
  async registrarMovimiento(datos: MovimientoNuevo, usuarioId: string): Promise<MovimientoEfectivoEntidad> {
    const caja = await this.cajaAbiertaDeHoy();
    const movimiento = this.movimientos.create({
      id: randomUUID(),
      cajaId: caja.id,
      tipo: datos.tipo,
      monto: new Decimal(datos.monto),
      motivo: datos.motivo,
      usuarioId,
      fecha: new Date(),
      ventaId: null,
      entradaId: null,
      devolucionId: null,
    });
    return conTransaccion(async (manager) => {
      await manager.insert(MovimientoEfectivoEntidad, movimiento);
      await this.bitacora.registrar(
        {
          usuarioId,
          accion: datos.tipo === 'RETIRO' ? 'CAJA_RETIRO' : 'CAJA_INGRESO',
          entidad: 'movimiento_efectivo',
          entidadId: movimiento.id,
          despues: { cajaId: caja.id, monto: movimiento.monto.toFixed(2), motivo: movimiento.motivo },
        },
        manager,
      );
      return movimiento;
    });
  }

  /**
   * Arqueo. El resultado lo decide evaluarArqueo (paquete compartido): 'CUADRA', 'RECONTAR' si el
   * primer conteo no cuadra, o 'JUSTIFICAR' si el reconteo tampoco.
   */
  async arquear(datos: ArqueoNuevo, usuarioId: string): Promise<ArqueoEntidad> {
    const caja = await this.cajaAbierta();
    const previos = await this.arqueos.find({ where: { cajaId: caja.id }, order: { intento: 'ASC' } });
    const ultimo = previos.at(-1);

    // Máximo dos conteos: si ya cuadró o ya se volvió a contar, lo que sigue es cerrar.
    if (ultimo?.resultado === 'CUADRA') {
      throw new Conflicto('El conteo ya cuadró; cierre la caja');
    }
    if (ultimo?.resultado === 'JUSTIFICAR') {
      throw new Conflicto('Ya se hizo el reconteo; cierre la caja con una justificación');
    }

    const intento = (previos.length + 1) as 1 | 2;
    const esperado = efectivoEsperado(caja.fondoInicial, await this.movimientosDe(caja.id));
    const contado = totalConteo(datos.conteo);
    const { resultado, diferencia } = evaluarArqueo(intento, contado, esperado);

    const arqueo = this.arqueos.create({
      id: randomUUID(),
      cajaId: caja.id,
      intento,
      resultado,
      contado,
      esperado,
      diferencia,
      usuarioId,
      fecha: new Date(),
    });

    // Una fila por cada billete o moneda que tenga al menos una pieza.
    const denominaciones = DENOMINACIONES.filter((d) => (datos.conteo[d.clave] ?? 0) > 0).map((d) => ({
      arqueoId: arqueo.id,
      clave: d.clave,
      valor: new Decimal(d.valor),
      cantidad: datos.conteo[d.clave]!,
    }));

    await this.guardarSinDuplicar(
      'Otra persona registró un conteo al mismo tiempo; consulte la caja actual',
      () =>
        conTransaccion(async (manager) => {
          await manager.insert(ArqueoEntidad, arqueo);
          if (denominaciones.length) await manager.insert(ArqueoDenominacionEntidad, denominaciones);
          await this.bitacora.registrar(
            {
              usuarioId,
              accion: 'CAJA_ARQUEO',
              entidad: 'arqueo',
              entidadId: arqueo.id,
              despues: {
                cajaId: caja.id,
                intento,
                resultado,
                contado: contado.toFixed(2),
                esperado: esperado.toFixed(2),
                diferencia: diferencia.toFixed(2),
              },
            },
            manager,
          );
        }),
    );
    return arqueo;
  }

  /**
   * Cierre con el último conteo, que se vuelve el fondo de la siguiente caja. En la misma transacción
   * se cancelan las ventas que no se cobraron.
   */
  async cerrar(datos: Cierre, usuarioId: string): Promise<DetalleCaja> {
    const caja = await this.cajaAbierta();
    const ultimo = await this.arqueos.findOne({ where: { cajaId: caja.id }, order: { intento: 'DESC' } });

    if (!ultimo) {
      throw new ReglaDeNegocio('Cuente el efectivo (arqueo) antes de cerrar la caja');
    }
    if (ultimo.resultado === 'RECONTAR') {
      throw new ReglaDeNegocio('El conteo no coincide: recuente el efectivo antes de cerrar');
    }
    if (ultimo.resultado === 'JUSTIFICAR' && !datos.justificacion) {
      throw new ReglaDeNegocio('La diferencia persiste: escriba una justificación para cerrar la caja');
    }

    caja.estado = 'CERRADA';
    caja.cerradaPor = usuarioId;
    caja.cerradaEn = new Date();
    caja.efectivoFinal = ultimo.contado;
    caja.diferencia = ultimo.diferencia;
    caja.justificacion = ultimo.resultado === 'JUSTIFICAR' ? datos.justificacion! : null;

    await conTransaccion(async (manager) => {
      // Las ventas abiertas las manda la interfaz y las cancela ventas.
      const ventasCanceladas = datos.ventasAbiertas.length
        ? await participanteCierre().cancelarVentasAbiertas(manager, caja.id, datos.ventasAbiertas)
        : 0;
      await manager.save(caja);
      await this.bitacora.registrar(
        {
          usuarioId,
          accion: 'CAJA_CERRADA',
          entidad: 'caja',
          entidadId: caja.id,
          despues: {
            fecha: caja.fecha,
            efectivoFinal: ultimo.contado.toFixed(2),
            diferencia: ultimo.diferencia.toFixed(2),
            justificacion: caja.justificacion,
            ventasCanceladas,
          },
        },
        manager,
      );
    });
    // El aviso y el respaldo no deben detener el cierre, que ya quedó guardado.
    await participanteCierre()
      .alCerrarCaja(caja)
      .catch((error: Error) => console.error(`No se pudo avisar el cierre: ${error.message}`));
    await new RespaldosServicio()
      .encolar(caja.id)
      .catch((error: Error) => console.error(`No se pudo pedir el respaldo: ${error.message}`));
    return this.detalle(caja);
  }

  // Para los módulos de ventas, inventario y devoluciones:

  /**
   * Caja abierta de hoy, para vender. Falla si la abierta es de otro día o si ya empezó el arqueo (una
   * venta después del conteo lo echaría a perder).
   */
  async cajaAbiertaDeHoy(): Promise<CajaEntidad> {
    const caja = await this.cajaAbierta();
    if (caja.fecha !== fechaLocal(new Date())) {
      throw new Conflicto(
        `La caja abierta es del ${caja.fecha}; haga su arqueo y ciérrela, y abra la de hoy`,
      );
    }
    if (await this.arqueos.existsBy({ cajaId: caja.id })) {
      throw new Conflicto('Ya empezó el arqueo de la caja; ciérrela antes de registrar más movimientos');
    }
    return caja;
  }

  /**
   * Registra el efectivo neto de una venta (lo recibido menos el cambio) para el esperado del arqueo.
   * Corre dentro de la transacción del cobro.
   */
  async registrarEfectivoDeVenta(
    manager: EntityManager,
    venta: { cajaId: string; ventaId: string; folio: number; monto: Decimal; usuarioId: string },
  ): Promise<void> {
    if (venta.monto.lte(0)) return; // se pagó sin efectivo
    await manager.insert(MovimientoEfectivoEntidad, {
      id: randomUUID(),
      cajaId: venta.cajaId,
      tipo: 'VENTA',
      monto: venta.monto,
      motivo: `Venta con folio ${venta.folio}`,
      usuarioId: venta.usuarioId,
      fecha: new Date(),
      ventaId: venta.ventaId,
    });
  }

  /**
   * Regla: revisa que el efectivo esperado de la caja alcance para un pago a proveedor o un reembolso.
   * `accion` completa el mensaje: "pagar" o "reembolsar".
   */
  async revisarSalidaDeEfectivo(
    caja: CajaEntidad,
    monto: Decimal,
    accion = 'pagar',
    manager: EntityManager = fuenteDatos.manager,
  ): Promise<void> {
    const movimientos = await manager.findBy(MovimientoEfectivoEntidad, { cajaId: caja.id });
    try {
      revisarEfectivoParaPago(monto, efectivoEsperado(caja.fondoInicial, movimientos), accion);
    } catch (error) {
      if (error instanceof RangeError) throw new ReglaDeNegocio(error.message);
      throw error;
    }
  }

  /**
   * Registra el pago de una entrada de mercancía; se resta del efectivo esperado y no puede pasarse de
   * él. Corre dentro de la transacción de inventario.
   */
  async registrarPagoProveedor(
    manager: EntityManager,
    pago: { cajaId: string; entradaId: string; monto: Decimal; motivo: string; usuarioId: string },
  ): Promise<MovimientoEfectivoEntidad> {
    // Candado por caja, para que dos pagos al mismo tiempo no usen el mismo efectivo.
    await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [pago.cajaId]);
    const caja = await manager.findOneByOrFail(CajaEntidad, { id: pago.cajaId });
    await this.revisarSalidaDeEfectivo(caja, pago.monto, 'pagar', manager);

    const movimiento = this.movimientos.create({
      id: randomUUID(),
      cajaId: pago.cajaId,
      tipo: 'PAGO_PROVEEDOR',
      monto: pago.monto,
      motivo: pago.motivo,
      usuarioId: pago.usuarioId,
      fecha: new Date(),
      ventaId: null,
      entradaId: pago.entradaId,
      devolucionId: null,
    });
    await manager.insert(MovimientoEfectivoEntidad, movimiento);
    return movimiento;
  }

  /**
   * Registra el reembolso en efectivo de una devolución; se resta del efectivo esperado y no puede
   * pasarse de él. Corre dentro de la transacción de la devolución.
   */
  async registrarReembolso(
    manager: EntityManager,
    reembolso: { cajaId: string; devolucionId: string; monto: Decimal; motivo: string; usuarioId: string },
  ): Promise<void> {
    // El mismo candado por caja que en el pago a proveedor.
    await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [reembolso.cajaId]);
    const caja = await manager.findOneByOrFail(CajaEntidad, { id: reembolso.cajaId });
    await this.revisarSalidaDeEfectivo(caja, reembolso.monto, 'reembolsar', manager);
    await manager.insert(MovimientoEfectivoEntidad, {
      id: randomUUID(),
      cajaId: reembolso.cajaId,
      tipo: 'DEVOLUCION',
      monto: reembolso.monto,
      motivo: reembolso.motivo,
      usuarioId: reembolso.usuarioId,
      fecha: new Date(),
      ventaId: null,
      entradaId: null,
      devolucionId: reembolso.devolucionId,
    });
  }

  /** Caja abierta, de hoy o de otro día; si no hay, error. */
  async cajaAbierta(): Promise<CajaEntidad> {
    const caja = await this.cajas.findOneBy({ estado: 'ABIERTA' });
    if (!caja) throw new ReglaDeNegocio('No hay una caja abierta; abra la caja primero');
    return caja;
  }

  // Ayudantes de adentro

  private async ultimaCerrada(): Promise<CajaEntidad | null> {
    return this.cajas.findOne({ where: { estado: 'CERRADA' }, order: { fecha: 'DESC' } });
  }

  private async movimientosDe(cajaId: string): Promise<MovimientoEfectivoEntidad[]> {
    return this.movimientos.find({ where: { cajaId }, order: { fecha: 'ASC' } });
  }

  /** Arma los datos que se enseñan de una caja. */
  private async detalle(caja: CajaEntidad): Promise<DetalleCaja> {
    const todos = await this.movimientosDe(caja.id);
    const ultimoArqueo = await this.arqueos.findOne({
      where: { cajaId: caja.id },
      order: { intento: 'DESC' },
    });
    // De las ventas solo se suma el efectivo.
    const ventasEfectivo = todos
      .filter((m) => m.tipo === 'VENTA')
      .reduce((total, m) => total.plus(m.monto), new Decimal(0));
    return {
      caja,
      movimientos: todos.filter((m) => m.tipo !== 'VENTA'),
      ventasEfectivo,
      ultimoArqueo,
      esperado: efectivoEsperado(caja.fondoInicial, todos),
    };
  }

  /**
   * Si dos peticiones hacen lo mismo al mismo tiempo (por ejemplo, abrir la caja), los índices únicos
   * rechazan la segunda con el código '23505'; aquí se convierte en un 409 con un mensaje claro.
   */
  private async guardarSinDuplicar(mensaje: string, guardar: () => Promise<void>): Promise<void> {
    try {
      await guardar();
    } catch (error) {
      if (error instanceof QueryFailedError && (error.driverError as { code?: string }).code === '23505') {
        throw new Conflicto(mensaje);
      }
      throw error;
    }
  }
}

// --- Rutas ---
// Dueño y Empleado usan la caja; solo el Dueño captura el fondo del primer día y ve el esperado.

const MENSAJE_ARQUEO = {
  CUADRA: 'El conteo cuadra; ya puede cerrar la caja',
  RECONTAR: 'El conteo no coincide; recuente el efectivo',
  JUSTIFICAR: 'La diferencia persiste; cierre la caja con una justificación',
} as const;

/** Dice si el rol puede ver el efectivo esperado (arqueo a ciegas). */
function verEsperado(req: Request): boolean {
  return tienePermiso(sesionDe(req).rol, 'caja:ver_esperado');
}

export function rutasCaja(): Router {
  const router = Router();
  const servicio = new CajaServicio();

  // GET /caja/actual
  router.get('/caja/actual', autenticar, autorizar('caja:abrir'), async (req, res) => {
    responder(res, aCajaActual(await servicio.actual(), verEsperado(req)), 'Caja actual');
  });

  // POST /caja/apertura
  router.post(
    '/caja/apertura',
    autenticar,
    autorizar('caja:abrir'),
    validar({ body: esquemaApertura }),
    async (req, res) => {
      const { usuarioId, rol } = sesionDe(req);
      const detalle = await servicio.abrir(datos<Apertura>(req, 'body'), usuarioId, rol);
      const alertas = await alertasAlAbrir();
      responder(res, { ...aCaja(detalle, verEsperado(req)), alertas }, 'Caja abierta', 201);
    },
  );

  // POST /caja/movimientos  { tipo, monto, motivo }
  router.post(
    '/caja/movimientos',
    autenticar,
    autorizar('caja:movimiento'),
    validar({ body: esquemaMovimientoNuevo }),
    async (req, res) => {
      const movimiento = await servicio.registrarMovimiento(
        datos<MovimientoNuevo>(req, 'body'),
        sesionDe(req).usuarioId,
      );
      const mensaje = movimiento.tipo === 'RETIRO' ? 'Retiro registrado' : 'Ingreso registrado';
      responder(res, aMovimiento(movimiento), mensaje, 201);
    },
  );

  // POST /caja/arqueo  { conteo: { B500: 2, M10: 5, ... } }
  router.post(
    '/caja/arqueo',
    autenticar,
    autorizar('caja:cerrar'),
    validar({ body: esquemaArqueo }),
    async (req, res) => {
      const arqueo = await servicio.arquear(datos<ArqueoNuevo>(req, 'body'), sesionDe(req).usuarioId);
      responder(res, aResultadoArqueo(arqueo, verEsperado(req)), MENSAJE_ARQUEO[arqueo.resultado], 201);
    },
  );

  // POST /caja/cierre  { justificacion?, ventasAbiertas }
  router.post(
    '/caja/cierre',
    autenticar,
    autorizar('caja:cerrar'),
    validar({ body: esquemaCierre }),
    async (req, res) => {
      const detalle = await servicio.cerrar(datos<Cierre>(req, 'body'), sesionDe(req).usuarioId);
      responder(res, aCaja(detalle, verEsperado(req)), 'Caja cerrada');
    },
  );

  return router;
}

// Formato de las respuestas (montos con 2 decimales y fechas ISO). Sin verEsperado, el esperado y
// la diferencia no se mandan.

function aMovimiento(m: MovimientoEfectivoEntidad): MovimientoEfectivo {
  return {
    id: m.id,
    tipo: m.tipo as Exclude<TipoEfectivo, 'VENTA'>, // las ventas no se listan
    monto: m.monto.toFixed(2),
    motivo: m.motivo,
    usuarioId: m.usuarioId,
    fecha: m.fecha.toISOString(),
    entradaId: m.entradaId,
    devolucionId: m.devolucionId,
  };
}

function aResultadoArqueo(a: ArqueoEntidad, verEsperado: boolean): ResultadoDeArqueo {
  return {
    intento: a.intento,
    resultado: a.resultado,
    contado: a.contado.toFixed(2),
    ...(verEsperado ? { esperado: a.esperado.toFixed(2), diferencia: a.diferencia.toFixed(2) } : {}),
  };
}

function aCaja(d: DetalleCaja, verEsperado: boolean): Caja {
  const c = d.caja;
  return {
    id: c.id,
    fecha: c.fecha,
    estado: c.estado,
    fondoInicial: c.fondoInicial.toFixed(2),
    abiertaPor: c.abiertaPor,
    abiertaEn: c.abiertaEn.toISOString(),
    cerradaPor: c.cerradaPor,
    cerradaEn: c.cerradaEn?.toISOString() ?? null,
    efectivoFinal: c.efectivoFinal?.toFixed(2) ?? null,
    justificacion: c.justificacion,
    ...(verEsperado
      ? {
          esperado: d.esperado.toFixed(2),
          ventasEfectivo: d.ventasEfectivo.toFixed(2),
          diferencia: c.diferencia?.toFixed(2) ?? null,
        }
      : {}),
    movimientos: d.movimientos.map(aMovimiento),
    ultimoArqueo: d.ultimoArqueo ? aResultadoArqueo(d.ultimoArqueo, verEsperado) : null,
  };
}

function aCajaActual(e: EstadoCaja, verEsperado: boolean): CajaActual {
  return {
    caja: e.detalle ? aCaja(e.detalle, verEsperado) : null,
    cajaDeOtroDia: e.cajaDeOtroDia,
    requiereFondoInicial: e.requiereFondoInicial,
    fondoPropuesto: e.fondoPropuesto?.toFixed(2) ?? null,
  };
}

// --- Swagger ---

export function documentarCaja(registro: OpenAPIRegistry): void {
  const etiqueta = 'Caja';
  documentar(registro, [
    {
      metodo: 'get',
      ruta: '/caja/actual',
      resumen: 'Estado de la caja: la abierta o la de hoy y el fondo propuesto',
      etiqueta,
      permiso: 'caja:abrir',
      respuesta: esquemaCajaActual,
    },
    {
      metodo: 'post',
      ruta: '/caja/apertura',
      resumen:
        'Abrir la caja del día con el efectivo del cierre anterior y ver el resumen de alertas; el primer día el Dueño captura el fondo',
      etiqueta,
      permiso: 'caja:abrir',
      body: esquemaApertura,
      respuesta: esquemaCajaAbierta,
      estado: 201,
      errores: [409, 422],
    },
    {
      metodo: 'post',
      ruta: '/caja/movimientos',
      resumen: 'Registrar un retiro o ingreso de efectivo',
      etiqueta,
      permiso: 'caja:movimiento',
      body: esquemaMovimientoNuevo,
      respuesta: esquemaMovimiento,
      estado: 201,
      errores: [409, 422],
    },
    {
      metodo: 'post',
      ruta: '/caja/arqueo',
      resumen: 'Contar el efectivo; si no cuadra se pide un reconteo y después una justificación',
      etiqueta,
      permiso: 'caja:cerrar',
      body: esquemaArqueo,
      respuesta: esquemaResultadoArqueo,
      estado: 201,
      errores: [409, 422],
    },
    {
      metodo: 'post',
      ruta: '/caja/cierre',
      resumen: 'Cerrar la caja con el último conteo, que será el fondo del día siguiente',
      etiqueta,
      permiso: 'caja:cerrar',
      body: esquemaCierre,
      respuesta: esquemaCaja,
      errores: [422],
    },
  ]);
}
