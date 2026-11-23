/**
 * Conversión de las columnas de dinero. PostgreSQL guarda NUMERIC (exacto) y lo entrega como texto
 * ("18.50"); en el código se usa Decimal para que no se pierdan centavos.
 * Uso en las entidades: @Column({ type: 'numeric', ..., transformer: columnaDecimal })
 */
import type { ValueTransformer } from 'typeorm';
import { Decimal } from '@pos/compartido';

export const columnaDecimal: ValueTransformer = {
  // null y undefined se dejan igual
  to: (valor: Decimal | null | undefined) => (valor == null ? valor : valor.toFixed(2)),
  from: (valor: string | null) => (valor == null ? null : new Decimal(valor)),
};
