/**
 * Los dos filtros de seguridad de las rutas: autenticar (¿quién eres?) y autorizar (¿te toca hacer
 * esto?). Uso: router.post('/productos', autenticar, autorizar('producto:crear'), ..., ruta)
 */
import type { RequestHandler } from 'express';
import { tienePermiso, type Permiso } from '@pos/compartido';
import { AccesoServicio } from '../modulos/acceso/acceso';
import { NoAutenticado, Prohibido } from './errores';

/**
 * Revisa el token que llega en "Authorization: Bearer <token>" y deja en req.sesion los datos del
 * usuario. Sin token, o con uno que no sirve, se responde 401.
 */
export const autenticar: RequestHandler = async (req, _res, next) => {
  const [tipo, token] = (req.headers.authorization ?? '').split(' ');
  if (tipo !== 'Bearer' || !token) return next(new NoAutenticado());
  try {
    req.sesion = await new AccesoServicio().verificar(token);
    next();
  } catch (error) {
    next(error);
  }
};

/**
 * Va después de autenticar. Responde 403 si el usuario todavía trae el PIN temporal o si su rol no
 * tiene el permiso (por ejemplo, el Empleado no puede cambiar precios). Los permisos de cada rol
 * están en paquetes/compartido/src/acceso/permisos.ts.
 */
export function autorizar(permiso?: Permiso): RequestHandler {
  return (req, _res, next) => {
    const sesion = req.sesion!; // autenticar ya la dejó lista
    if (sesion.debeCambiarPin) {
      return next(new Prohibido('Antes de continuar debe cambiar su PIN temporal'));
    }
    if (permiso && !tienePermiso(sesion.rol, permiso)) {
      // 'producto:precio' se muestra como 'producto → precio'
      const descripcion = permiso.replace(':', ' → ').replace(/_/g, ' ');
      return next(new Prohibido(`Su rol no tiene permiso para esta operación (${descripcion})`));
    }
    next();
  };
}
