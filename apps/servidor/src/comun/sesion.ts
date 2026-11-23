/**
 * La sesión de la petición: autenticar (seguridad.ts) la deja en req.sesion y las rutas la leen con
 * sesionDe(req), por ejemplo para anotar en la bitácora quién hizo qué.
 */
import type { Request } from 'express';
import type { Rol } from '@pos/compartido';
import { NoAutenticado } from './errores';

export interface SesionActual {
  usuarioId: string;
  rol: Rol;
  sesionId: string;
  debeCambiarPin: boolean; // todavía trae el PIN temporal
}

// Se le agrega a Request el campo "sesion" para que TypeScript no se queje.
declare module 'express-serve-static-core' {
  interface Request {
    sesion?: SesionActual;
  }
}

/** Devuelve la sesión de la petición; si no hay, responde 401. */
export function sesionDe(req: Request): SesionActual {
  if (!req.sesion) throw new NoAutenticado();
  return req.sesion;
}
