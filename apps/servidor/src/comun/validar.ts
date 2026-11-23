/**
 * Validación de lo que llega, con esquemas de Zod (están en paquetes/compartido/src/esquemas para que
 * la interfaz use exactamente las mismas reglas). Se pueden validar los params (/productos/:id), el
 * query (?buscar=coca) y el body (JSON).
 *
 * Uso: router.post('/productos', ..., validar({ body: esquemaProductoNuevo }), (req, res) => {
 *        const producto = datos<ProductoNuevo>(req, 'body');
 *      });
 */
import type { Request, RequestHandler } from 'express';
import type { z } from 'zod';
import { SolicitudInvalida } from './errores';

type Parte = 'body' | 'params' | 'query';
export type EsquemasDeRuta = Partial<Record<Parte, z.ZodType>>;

// Se le agrega a Request el campo "validado" con los datos ya revisados.
declare module 'express-serve-static-core' {
  interface Request {
    validado?: Partial<Record<Parte, unknown>>;
  }
}

/** Si algún dato no sirve, se responde 400 con la lista de campos y qué tiene cada uno. */
export function validar(esquemas: EsquemasDeRuta): RequestHandler {
  return (req, _res, next) => {
    const validado: Partial<Record<Parte, unknown>> = {};
    const errores: { campo: string; mensaje: string }[] = [];

    for (const parte of ['params', 'query', 'body'] as const) {
      const esquema = esquemas[parte];
      if (!esquema) continue;

      const resultado = esquema.safeParse(req[parte] ?? {});
      if (resultado.success) {
        // data ya viene limpio (sin espacios de más, números convertidos, etc.)
        validado[parte] = resultado.data;
      } else {
        // Cada error se reporta con su campo, por ejemplo "body.precio".
        for (const issue of resultado.error.issues) {
          errores.push({ campo: [parte, ...issue.path].join('.'), mensaje: mensajeDe(issue) });
        }
      }
    }

    if (errores.length) {
      return next(new SolicitudInvalida('Uno o más datos no son válidos', errores));
    }
    req.validado = validado;
    next();
  };
}

/** Devuelve los datos ya validados de una parte de la petición. */
export function datos<T>(req: Request, parte: Parte): T {
  return req.validado?.[parte] as T;
}

/** Mensajes más claros para dos casos que salen mucho. */
function mensajeDe(issue: z.core.$ZodIssue): string {
  if (issue.code === 'invalid_type' && issue.input === undefined) return 'Es obligatorio';
  if (issue.code === 'unrecognized_keys') return `No se permite: ${issue.keys.join(', ')}`;
  return issue.message;
}
