/**
 * Conexión a PostgreSQL con TypeORM (el AppDataSource): datos de conexión del .env, las entidades de
 * cada módulo y las migraciones. Como synchronize está en false, las tablas solo cambian con
 * migraciones. La conexión se abre en main-api.ts con initialize().
 */
import 'reflect-metadata'; // TypeORM lo necesita para leer los decoradores @Entity y @Column
import { DataSource } from 'typeorm';
import { SesionEntidad } from '../../modulos/acceso/acceso.tablas';
import { BitacoraEntidad } from '../../modulos/bitacora/bitacora.tablas';
import {
  ArqueoDenominacionEntidad,
  ArqueoEntidad,
  CajaEntidad,
  MovimientoEfectivoEntidad,
} from '../../modulos/caja/caja.tablas';
import {
  CategoriaEntidad,
  HistorialPrecioEntidad,
  ProductoEntidad,
} from '../../modulos/catalogo/catalogo.tablas';
import { ConfiguracionEntidad } from '../../modulos/configuracion/configuracion.tablas';
import {
  AjusteEntidad,
  AjusteLoteEntidad,
  EjecucionTareaEntidad,
  EntradaDetalleEntidad,
  EntradaEntidad,
  LoteEntidad,
  SalidaEntidad,
} from '../../modulos/inventario/inventario.tablas';
import {
  DevolucionDetalleEntidad,
  DevolucionEntidad,
  DevolucionLoteEntidad,
} from '../../modulos/devoluciones/devoluciones.tablas';
import { ClienteEntidad, ConsentimientoEntidad } from '../../modulos/clientes/clientes.tablas';
import { EnvioEntidad } from '../../modulos/notificaciones/notificaciones.tablas';
import { RespaldoEntidad } from '../../modulos/respaldos/respaldos.tablas';
import { ExportacionEntidad } from '../../modulos/reportes/reportes.tablas';
import { PromocionEntidad } from '../../modulos/promociones/promociones.tablas';
import { ProveedorEntidad } from '../../modulos/proveedores/proveedores.tablas';
import { UsuarioEntidad } from '../../modulos/usuarios/usuarios.tablas';
import {
  PagoEntidad,
  SaldoFavorEntidad,
  VentaDetalleEntidad,
  VentaDetalleLoteEntidad,
  VentaEntidad,
} from '../../modulos/ventas/ventas.tablas';
import { EsquemaInicial1792220400000 } from '../../migraciones/1792220400000-EsquemaInicial';
import { Configuracion1792300000000 } from '../../migraciones/1792300000000-Configuracion';
import { Caja1792300100000 } from '../../migraciones/1792300100000-Caja';
import { Lote1792300200000 } from '../../migraciones/1792300200000-Lote';
import { Ventas1792300300000 } from '../../migraciones/1792300300000-Ventas';
import { Proveedores1792990030249 } from '../../migraciones/1792990030249-Proveedores';
import { Entradas1792990836046 } from '../../migraciones/1792990836046-Entradas';
import { PagoProveedor1793000000000 } from '../../migraciones/1793000000000-PagoProveedor';
import { Salidas1793000100000 } from '../../migraciones/1793000100000-Salidas';
import { Ajustes1793000200000 } from '../../migraciones/1793000200000-Ajustes';
import { EjecucionTarea1793000300000 } from '../../migraciones/1793000300000-EjecucionTarea';
import { Devoluciones1793000400000 } from '../../migraciones/1793000400000-Devoluciones';
import { SaldoFavor1793000500000 } from '../../migraciones/1793000500000-SaldoFavor';
import { Promociones1793000600000 } from '../../migraciones/1793000600000-Promociones';
import { PromocionesEnVenta1793000700000 } from '../../migraciones/1793000700000-PromocionesEnVenta';
import { Clientes1793000800000 } from '../../migraciones/1793000800000-Clientes';
import { Envios1793000900000 } from '../../migraciones/1793000900000-Envios';
import { TelegramDueno1793001000000 } from '../../migraciones/1793001000000-TelegramDueno';
import { Respaldos1793001100000 } from '../../migraciones/1793001100000-Respaldos';
import { Exportaciones1793001200000 } from '../../migraciones/1793001200000-Exportaciones';

export const fuenteDatos = new DataSource({
  type: 'postgres',
  host: process.env.DB_HOST ?? '127.0.0.1',
  port: Number(process.env.DB_PUERTO ?? 5432),
  username: process.env.DB_USUARIO ?? 'pos',
  password: process.env.DB_CLAVE ?? 'pos_local',
  database: process.env.DB_NOMBRE ?? 'pos',

  entities: [
    UsuarioEntidad, // usuarios
    SesionEntidad, // acceso
    BitacoraEntidad, // bitácora
    CategoriaEntidad, // catálogo
    ProductoEntidad,
    HistorialPrecioEntidad,
    ConfiguracionEntidad, // configuración
    CajaEntidad, // caja
    MovimientoEfectivoEntidad,
    ArqueoEntidad,
    ArqueoDenominacionEntidad,
    LoteEntidad, // inventario
    EntradaEntidad,
    EntradaDetalleEntidad,
    SalidaEntidad,
    AjusteEntidad,
    AjusteLoteEntidad,
    EjecucionTareaEntidad,
    VentaEntidad, // ventas
    VentaDetalleEntidad,
    VentaDetalleLoteEntidad,
    PagoEntidad,
    SaldoFavorEntidad,
    ProveedorEntidad, // proveedores
    DevolucionEntidad, // devoluciones
    DevolucionDetalleEntidad,
    DevolucionLoteEntidad,
    PromocionEntidad, // promociones
    ClienteEntidad, // clientes
    ConsentimientoEntidad,
    EnvioEntidad, // notificaciones
    RespaldoEntidad, // respaldos
    ExportacionEntidad, // reportes
  ],

  // En orden. Las que ya se aplicaron quedan apuntadas en la tabla "migracion".
  migrations: [
    EsquemaInicial1792220400000,
    Configuracion1792300000000,
    Caja1792300100000,
    Lote1792300200000,
    Ventas1792300300000,
    Proveedores1792990030249,
    Entradas1792990836046,
    PagoProveedor1793000000000,
    Salidas1793000100000,
    Ajustes1793000200000,
    EjecucionTarea1793000300000,
    Devoluciones1793000400000,
    SaldoFavor1793000500000,
    Promociones1793000600000,
    PromocionesEnVenta1793000700000,
    Clientes1793000800000,
    Envios1793000900000,
    TelegramDueno1793001000000,
    Respaldos1793001100000,
    Exportaciones1793001200000,
  ],
  // Las conexiones no se cierran aunque estén sin uso (pg las cerraría a los 10 s). Así la restauración
  // se da cuenta de que la API o el worker siguen encendidos aunque nadie los esté usando.
  extra: { idleTimeoutMillis: 0 },
  migrationsTableName: 'migracion',
  synchronize: false,
  logging: ['error'], // solo se muestran los errores de SQL
});
