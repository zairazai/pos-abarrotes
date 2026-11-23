/**
 * Errores de la API. Los módulos solo lanzan uno de estos (throw new NoEncontrado('...')) y el
 * manejador central arma la respuesta, siempre con el formato RFC 7807:
 *   { "type": "about:blank", "title": "...", "status": 404, "detail": "...", "instance": "/api/v1/..." }
 *
 * 400 SolicitudInvalida, 401 NoAutenticado, 403 Prohibido, 404 NoEncontrado, 409 Conflicto,
 * 422 ReglaDeNegocio (una regla de la tienda no lo deja), 423 AccesoBloqueado y
 * 503 ServicioNoDisponible.
 */
import type { ErrorRequestHandler, RequestHandler } from 'express';

/** Campo con error y su motivo. */
export interface ErrorDeCampo {
  campo: string;
  mensaje: string;
}

/** Error base; los demás solo ponen su código HTTP y su título. */
export class ErrorAplicacion extends Error {
  constructor(
    readonly status: number,
    readonly titulo: string,
    detalle: string,
    readonly errores?: ErrorDeCampo[],
    readonly extras?: Record<string, unknown>, // datos extra, por ejemplo los segundos que hay que esperar
  ) {
    super(detalle);
  }
}

export class SolicitudInvalida extends ErrorAplicacion {
  constructor(detalle: string, errores?: ErrorDeCampo[]) {
    super(400, 'Solicitud inválida', detalle, errores);
  }
}

export class NoEncontrado extends ErrorAplicacion {
  constructor(detalle: string) {
    super(404, 'Recurso no encontrado', detalle);
  }
}

export class Conflicto extends ErrorAplicacion {
  constructor(detalle: string) {
    super(409, 'Conflicto con datos existentes', detalle);
  }
}

export class ReglaDeNegocio extends ErrorAplicacion {
  constructor(detalle: string) {
    super(422, 'Operación no permitida por una regla de negocio', detalle);
  }
}

export class NoAutenticado extends ErrorAplicacion {
  constructor(detalle = 'Inicie sesión con su PIN') {
    super(401, 'Sesión requerida', detalle);
  }
}

/** Regla: lo que no está permitido se rechaza y ya; no hay "que venga el Dueño a autorizar". */
export class Prohibido extends ErrorAplicacion {
  constructor(detalle: string) {
    super(403, 'Acceso denegado', detalle);
  }
}

/** Regla: después de 5 PIN incorrectos, la caja se bloquea unos minutos. */
export class AccesoBloqueado extends ErrorAplicacion {
  constructor(segundos: number) {
    const minutos = Math.ceil(segundos / 60);
    super(
      423,
      'Acceso bloqueado',
      `Se bloqueó el acceso por intentos fallidos. Intente de nuevo en ${minutos} ${minutos === 1 ? 'minuto' : 'minutos'}`,
      undefined,
      { reintentarEnSegundos: segundos },
    );
  }
}

/** Un servicio del que depende la operación no responde, por ejemplo Redis. */
export class ServicioNoDisponible extends ErrorAplicacion {
  constructor(detalle: string) {
    super(503, 'Servicio no disponible', detalle);
  }
}

/** Va al final de las rutas: si ninguna coincidió, se responde 404. */
export const rutaNoEncontrada: RequestHandler = (req, _res, next) => {
  next(new NoEncontrado(`No existe la ruta ${req.method} ${req.originalUrl}`));
};

/** Manejador central de errores (Express sabe que es de errores porque recibe 4 parámetros). */
export const manejadorDeErrores: ErrorRequestHandler = (error, req, res, _next) => {
  let problema: ErrorAplicacion;

  if (error instanceof ErrorAplicacion) {
    problema = error;
  } else if (error?.type === 'entity.parse.failed') {
    problema = new SolicitudInvalida('El cuerpo de la solicitud no es un JSON válido');
  } else if (error?.type === 'entity.too.large') {
    problema = new ErrorAplicacion(
      413,
      'Solicitud demasiado grande',
      'El cuerpo de la solicitud excede el límite',
    );
  } else {
    // Error que nadie esperaba: el detalle se anota en la consola y al cliente solo se le da un mensaje
    // general, para no enseñar nada interno.
    console.error(error);
    problema = new ErrorAplicacion(500, 'Error interno', 'Ocurrió un error inesperado; intente de nuevo');
  }

  res
    .status(problema.status)
    .type('application/problem+json')
    .json({
      type: 'about:blank',
      title: problema.titulo,
      status: problema.status,
      detail: problema.message,
      instance: req.originalUrl,
      ...(problema.errores ? { errores: problema.errores } : {}),
      ...problema.extras,
    });
};
