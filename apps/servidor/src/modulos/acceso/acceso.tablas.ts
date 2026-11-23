/** Entidad de sesiones: se abre una cada vez que alguien entra con su PIN. */
import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * Tabla `sesion`. Guarda el hash del token de renovación, que sirve para pedir un token de acceso
 * nuevo sin volver a teclear el PIN. Al cerrar sesión se llena revocadaEn y ya no sirve.
 */
@Entity('sesion')
export class SesionEntidad {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'usuario_id', type: 'uuid' })
  usuarioId!: string;

  @Column({ name: 'token_hash', type: 'char', length: 64, unique: true })
  tokenHash!: string;

  @Column({ name: 'creada_en', type: 'timestamptz' })
  creadaEn!: Date;

  // Vence al final del día.
  @Column({ name: 'expira_en', type: 'timestamptz' })
  expiraEn!: Date;

  // null mientras la sesión siga abierta.
  @Column({ name: 'revocada_en', type: 'timestamptz', nullable: true })
  revocadaEn!: Date | null;
}
