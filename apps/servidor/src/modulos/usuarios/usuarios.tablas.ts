/** Entidad de usuarios: el Dueño y los empleados. */
import { Column, Entity, PrimaryColumn } from 'typeorm';
import type { Rol } from '@pos/compartido';

/** Tabla `usuario`. Los usuarios no se borran, se desactivan. */
@Entity('usuario')
export class UsuarioEntidad {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 80 })
  nombre!: string;

  @Column({ type: 'varchar', length: 10 })
  rol!: Rol;

  // Hash bcrypt del PIN; el PIN nunca se guarda tal cual.
  @Column({ name: 'pin_hash', type: 'varchar', length: 100 })
  pinHash!: string;

  // Modo accesible: voz, letra grande y alto contraste.
  @Column({ name: 'modo_accesible', type: 'boolean' })
  modoAccesible!: boolean;

  // Tamaño de letra en porcentaje (100 = normal).
  @Column({ name: 'tamano_letra', type: 'smallint' })
  tamanoLetra!: number;

  @Column({ type: 'boolean' })
  activo!: boolean;

  // Trae PIN temporal y tiene que cambiarlo al entrar.
  @Column({ name: 'debe_cambiar_pin', type: 'boolean' })
  debeCambiarPin!: boolean;

  @Column({ name: 'creado_en', type: 'timestamptz' })
  creadoEn!: Date;

  @Column({ name: 'actualizado_en', type: 'timestamptz' })
  actualizadoEn!: Date;
}
