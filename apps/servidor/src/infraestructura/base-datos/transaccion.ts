/**
 * Transacciones con QueryRunner. Cuando una operación guarda varias cosas (por ejemplo, cobrar: venta,
 * inventario, caja y bitácora), se guarda todo o no se guarda nada; nunca queda a medias.
 *
 * Uso:
 *   await conTransaccion(async (manager) => {
 *     await manager.save(producto);
 *     await this.bitacora.registrar({...}, manager);
 *   });
 */
import type { EntityManager } from 'typeorm';
import { fuenteDatos } from './fuente';

export async function conTransaccion<T>(trabajo: (manager: EntityManager) => Promise<T>): Promise<T> {
  const queryRunner = fuenteDatos.createQueryRunner();

  await queryRunner.connect();
  await queryRunner.startTransaction();
  try {
    // Todo lo que se guarde con este manager forma parte de la transacción.
    const resultado = await trabajo(queryRunner.manager);
    await queryRunner.commitTransaction();
    return resultado;
  } catch (error) {
    await queryRunner.rollbackTransaction();
    throw error;
  } finally {
    // La conexión se regresa al pool pase lo que pase.
    await queryRunner.release();
  }
}

/**
 * Escapa los comodines de LIKE (% y _) para que se busquen como texto normal; así "50%" se busca tal
 * cual y no como "50 seguido de lo que sea".
 */
export function textoLiteral(texto: string): string {
  return texto.replace(/[\\%_]/g, (c) => `\\${c}`);
}
