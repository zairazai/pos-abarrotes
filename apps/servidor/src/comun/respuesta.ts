/**
 * Formato de las respuestas buenas: { success: true, data, message } y, en las listas por páginas,
 * también meta: { page, limit, totalPages, totalRecords }. Los errores tienen su propio formato
 * (errores.ts).
 */
import type { Response } from 'express';
import type { Paginacion } from '@pos/compartido';

/** Envía una respuesta correcta (200 por defecto, 201 cuando se crea algo). */
export function responder(
  res: Response,
  data: unknown,
  message: string,
  status = 200,
  meta?: Paginacion,
): void {
  res.status(status).json({ success: true, data, message, ...(meta ? { meta } : {}) });
}

/** Datos de paginación; por ejemplo, 45 registros de 20 en 20 dan 3 páginas. */
export function paginacion(page: number, limit: number, totalRecords: number): Paginacion {
  return { page, limit, totalPages: Math.ceil(totalRecords / limit), totalRecords };
}
