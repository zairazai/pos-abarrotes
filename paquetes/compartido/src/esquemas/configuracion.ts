/** Lo que se valida en la configuración de la tienda. */
import { z } from 'zod';
import { textoRequerido } from './comunes';

/** Texto que puede ir vacío; si no se manda, se guarda vacío. */
const textoOpcional = (max: number) =>
  z.string().trim().max(max, `Debe tener como máximo ${max} caracteres`).default('');

/** Datos de la tienda que salen en el ticket. */
export const esquemaConfiguracionModificada = z.strictObject({
  nombre: textoRequerido(80),
  direccion: textoOpcional(160),
  telefono: textoOpcional(20).refine(
    (v) => /^[\d\s()+-]*$/.test(v),
    'Solo dígitos, espacios, guiones, paréntesis y +',
  ),
  politicaDevolucion: textoRequerido(300),
  enlaceBot: textoOpcional(200).refine(
    (v) => v === '' || /^https:\/\/t\.me\/\w+$/.test(v),
    'Debe ser un enlace de Telegram, por ejemplo https://t.me/MiTiendaBot',
  ),
});

export const esquemaConfiguracion = z.object({
  nombre: z.string(),
  direccion: z.string(),
  telefono: z.string(),
  politicaDevolucion: z.string(),
  enlaceBot: z.string(),
  telegramDuenoVinculado: z.boolean(), // el Dueño ya recibe sus avisos por Telegram
  actualizadoEn: z.string(),
});

/** Código que el Dueño manda al bot con /dueno para recibir sus avisos por Telegram. */
export const esquemaCodigoTelegram = z.object({
  codigo: z.string(),
  venceEn: z.string(),
});

export type ConfiguracionModificada = z.infer<typeof esquemaConfiguracionModificada>;
export type ConfiguracionTienda = z.infer<typeof esquemaConfiguracion>;
export type CodigoTelegram = z.infer<typeof esquemaCodigoTelegram>;
