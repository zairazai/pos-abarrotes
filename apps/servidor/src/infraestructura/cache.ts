/**
 * Caché en Redis con el patrón cache-aside: primero se busca aquí y, si no está, se va a PostgreSQL.
 * Si Redis falla, se hace como si la clave no existiera y listo.
 */
import { claveRedis as clave, redis } from './redis';

/** Claves de un producto: por id y por código (en mayúsculas, porque el código no las distingue). */
export const clavesProducto = (p: { id: string; codigo: string }) => [
  `producto:id:${p.id}`,
  `producto:codigo:${p.codigo.toUpperCase()}`,
];

export async function leerCache<T>(nombre: string): Promise<T | null> {
  try {
    const valor = await redis.get(clave(nombre));
    return valor === null ? null : (JSON.parse(String(valor)) as T);
  } catch {
    return null;
  }
}

/** Guarda el valor por los segundos indicados (TTL). */
export async function guardarCache(nombre: string, valor: unknown, segundos: number): Promise<void> {
  try {
    await redis.set(clave(nombre), JSON.stringify(valor), { EX: segundos });
  } catch {
    // Sin Redis no se guarda; la siguiente consulta irá directo a PostgreSQL.
  }
}

/**
 * Borra toda la caché de esta base (productos y promociones). Se usa al restaurar un respaldo, porque
 * Redis se acordaría de datos que la base ya no tiene. Regresa cuántas claves borró; sin Redis, cero.
 */
export async function vaciarCache(): Promise<number> {
  let borradas = 0;
  try {
    for (const patron of ['producto:*', 'promociones:*']) {
      for await (const claves of redis.scanIterator({ MATCH: clave(patron), COUNT: 100 })) {
        if (claves.length > 0) borradas += await redis.del(claves);
      }
    }
  } catch {
    // Si Redis no responde, las claves vencen solas por su TTL.
  }
  return borradas;
}

/** Invalidación: borra las claves para que la siguiente consulta lea el dato nuevo. */
export async function borrarCache(...nombres: string[]): Promise<void> {
  if (nombres.length === 0) return;
  try {
    await redis.del(nombres.map(clave));
  } catch {
    // Si Redis no responde, las claves vencen solas por su TTL.
  }
}
