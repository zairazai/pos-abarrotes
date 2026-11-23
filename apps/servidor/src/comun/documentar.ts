/**
 * Ayudante para Swagger. Cada módulo describe sus rutas en una lista corta (método, ruta, resumen,
 * permiso y esquemas) y aquí se rellena lo demás: respuestas de error, formato de la respuesta y el
 * candado del token. Se usan los mismos esquemas Zod que en la validación, así la documentación nunca
 * se queda atrás. Esto solo documenta: una ruta que no aparezca aquí funciona igual.
 */
import type { OpenAPIRegistry, ResponseConfig } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import type { Permiso } from '@pos/compartido';

/** Descripción de una ruta para Swagger (la ruta real está en el archivo del módulo). */
export interface DocumentoRuta {
  metodo: 'get' | 'post' | 'put' | 'patch' | 'delete';
  /** Ruta con el formato de Express, por ejemplo "/productos/:id". */
  ruta: string;
  resumen: string;
  etiqueta: string;
  /** Sin sesión: salud, inicio de sesión y renovación. */
  publica?: boolean;
  /** Permiso que exige la ruta. */
  permiso?: Permiso;
  params?: z.ZodObject;
  query?: z.ZodObject;
  /** Cabeceras propias de la ruta, por ejemplo Idempotency-Key. */
  cabeceras?: z.ZodObject;
  body?: z.ZodType;
  /** Esquema del campo data de la respuesta correcta. */
  respuesta?: z.ZodType;
  /** La respuesta es un archivo y no JSON (por ejemplo, el ticket en PDF); puede ser de varios tipos. */
  archivo?: string | string[];
  /** 202: se aceptó y el worker se encarga después. */
  estado?: 200 | 201 | 202;
  /** Códigos de error propios de la ruta, además de 400, 401, 403 y 500. */
  errores?: (401 | 404 | 409 | 422 | 423 | 503)[];
  paginada?: boolean;
}

const problema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number(),
  detail: z.string(),
  instance: z.string(),
  errores: z.array(z.object({ campo: z.string(), mensaje: z.string() })).optional(),
});

const meta = z.object({
  page: z.number(),
  limit: z.number(),
  totalPages: z.number(),
  totalRecords: z.number(),
});

const DESCRIPCION_ERROR: Record<number, string> = {
  400: 'Datos inválidos; indica el campo exacto',
  401: 'Sesión requerida o PIN incorrecto',
  403: 'Sin permiso para la operación',
  404: 'No encontrado',
  409: 'Conflicto con datos existentes',
  422: 'Regla de negocio no cumplida',
  423: 'Acceso bloqueado por intentos fallidos',
  500: 'Error interno',
  503: 'Un servicio del que depende la API no responde',
};

/** Registra las rutas en la especificación OpenAPI; el permiso queda en el campo `x-permiso`. */
export function documentar(registro: OpenAPIRegistry, rutas: DocumentoRuta[]): void {
  for (const r of rutas) {
    const estado = r.estado ?? 200;
    const cuerpo = z.object({
      success: z.literal(true),
      data: r.respuesta ?? z.null(),
      message: z.string(),
      ...(r.paginada ? { meta } : {}),
    });
    const binario = { schema: z.string().meta({ format: 'binary' }) };
    const contenido = r.archivo
      ? Object.fromEntries([r.archivo].flat().map((tipo) => [tipo, binario]))
      : { 'application/json': { schema: cuerpo } };
    const responses: Record<string, ResponseConfig> = {
      [estado]: { description: 'Correcto', content: contenido },
    };
    const validaDatos = r.params || r.query || r.body || r.cabeceras;
    const codigos = new Set([
      ...(validaDatos ? [400] : []),
      ...(r.publica ? [] : [401, 403]),
      ...(r.errores ?? []),
      500,
    ]);
    for (const codigo of [...codigos].sort()) {
      responses[codigo] = {
        description: DESCRIPCION_ERROR[codigo]!,
        content: { 'application/problem+json': { schema: problema } },
      };
    }
    registro.registerPath({
      method: r.metodo,
      path: '/api/v1' + r.ruta.replace(/:(\w+)/g, '{$1}'),
      summary: r.resumen,
      description: r.permiso ? `Permiso requerido: \`${r.permiso}\`` : undefined,
      tags: [r.etiqueta],
      ...(r.publica ? {} : { security: [{ tokenAcceso: [] }] }),
      ...(r.permiso ? { 'x-permiso': r.permiso } : {}),
      request: {
        ...(r.params ? { params: r.params } : {}),
        ...(r.query ? { query: r.query } : {}),
        ...(r.cabeceras ? { headers: r.cabeceras } : {}),
        ...(r.body ? { body: { content: { 'application/json': { schema: r.body } }, required: true } } : {}),
      },
      responses,
    });
  }
}
