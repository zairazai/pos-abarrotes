/** Entidades de la caja: la caja del día, los movimientos de efectivo y los arqueos. */
import { Column, Entity, PrimaryColumn } from 'typeorm';
import type { ConteoEfectivo, Decimal, ResultadoArqueo, TipoEfectivo } from '@pos/compartido';
import { columnaDecimal } from '../../infraestructura/base-datos/decimal';

/** Tabla `caja`. Regla: una por día. */
@Entity('caja')
export class CajaEntidad {
  @PrimaryColumn('uuid')
  id!: string;

  // Día en hora de la tienda (AAAA-MM-DD).
  @Column({ type: 'date' })
  fecha!: string;

  @Column({ type: 'varchar', length: 8 })
  estado!: 'ABIERTA' | 'CERRADA';

  // Efectivo con el que abre. Regla: es lo que quedó en el cierre anterior.
  @Column({ name: 'fondo_inicial', type: 'numeric', precision: 12, scale: 2, transformer: columnaDecimal })
  fondoInicial!: Decimal;

  // Conteo del fondo, solo en la primera caja; en las demás va null.
  @Column({ name: 'conteo_fondo', type: 'jsonb', nullable: true })
  conteoFondo!: ConteoEfectivo | null;

  @Column({ name: 'abierta_por', type: 'uuid' })
  abiertaPor!: string;

  @Column({ name: 'abierta_en', type: 'timestamptz' })
  abiertaEn!: Date;

  // Datos del cierre.
  @Column({ name: 'cerrada_por', type: 'uuid', nullable: true })
  cerradaPor!: string | null;

  @Column({ name: 'cerrada_en', type: 'timestamptz', nullable: true })
  cerradaEn!: Date | null;

  // Efectivo contado al cerrar; con eso arranca la siguiente caja.
  @Column({
    name: 'efectivo_final',
    type: 'numeric',
    precision: 12,
    scale: 2,
    nullable: true,
    transformer: columnaDecimal,
  })
  efectivoFinal!: Decimal | null;

  // contado - esperado (positivo: sobró; negativo: faltó).
  @Column({ type: 'numeric', precision: 12, scale: 2, nullable: true, transformer: columnaDecimal })
  diferencia!: Decimal | null;

  // Obligatoria si después de volver a contar sigue sin cuadrar.
  @Column({ type: 'varchar', length: 300, nullable: true })
  justificacion!: string | null;
}

/** Tabla `movimiento_efectivo`: todo el efectivo que entra y sale de la caja. */
@Entity('movimiento_efectivo')
export class MovimientoEfectivoEntidad {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'caja_id', type: 'uuid' })
  cajaId!: string;

  // 'RETIRO' e 'INGRESO' los registra el cajero; 'VENTA' lo pone el cobro y 'PAGO_PROVEEDOR',
  // inventario.
  @Column({ type: 'varchar', length: 15 })
  tipo!: TipoEfectivo;

  @Column({ type: 'numeric', precision: 12, scale: 2, transformer: columnaDecimal })
  monto!: Decimal;

  @Column({ type: 'varchar', length: 200 })
  motivo!: string;

  @Column({ name: 'usuario_id', type: 'uuid' })
  usuarioId!: string;

  @Column({ type: 'timestamptz' })
  fecha!: Date;

  // Solo en los de tipo 'VENTA'.
  @Column({ name: 'venta_id', type: 'uuid', nullable: true })
  ventaId!: string | null;

  // Solo en los de tipo 'PAGO_PROVEEDOR'; una entrada se paga una sola vez.
  @Column({ name: 'entrada_id', type: 'uuid', nullable: true })
  entradaId!: string | null;

  // Solo en los de tipo 'DEVOLUCION': el reembolso de esa devolución.
  @Column({ name: 'devolucion_id', type: 'uuid', nullable: true })
  devolucionId!: string | null;
}

/** Tabla `arqueo`: conteos del efectivo para cerrar. Regla: el intento 2 es el reconteo y ya no hay más. */
@Entity('arqueo')
export class ArqueoEntidad {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'caja_id', type: 'uuid' })
  cajaId!: string;

  @Column({ type: 'smallint' })
  intento!: 1 | 2;

  // 'CUADRA', 'RECONTAR' o 'JUSTIFICAR'.
  @Column({ type: 'varchar', length: 10 })
  resultado!: ResultadoArqueo;

  @Column({ type: 'numeric', precision: 12, scale: 2, transformer: columnaDecimal })
  contado!: Decimal;

  @Column({ type: 'numeric', precision: 12, scale: 2, transformer: columnaDecimal })
  esperado!: Decimal;

  @Column({ type: 'numeric', precision: 12, scale: 2, transformer: columnaDecimal })
  diferencia!: Decimal;

  @Column({ name: 'usuario_id', type: 'uuid' })
  usuarioId!: string;

  @Column({ type: 'timestamptz' })
  fecha!: Date;
}

/** Tabla `arqueo_denominacion`: piezas de cada billete o moneda en un conteo. */
@Entity('arqueo_denominacion')
export class ArqueoDenominacionEntidad {
  @PrimaryColumn({ name: 'arqueo_id', type: 'uuid' })
  arqueoId!: string;

  // Por ejemplo 'B500' (billete de 500) o 'M10' (moneda de 10).
  @PrimaryColumn({ type: 'varchar', length: 5 })
  clave!: string;

  // Lo que vale una pieza.
  @Column({ type: 'numeric', precision: 7, scale: 2, transformer: columnaDecimal })
  valor!: Decimal;

  @Column({ type: 'integer' })
  cantidad!: number;
}
