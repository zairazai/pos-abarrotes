/**
 * Arranque del bot de Telegram. Solo corre si el .env trae TELEGRAM_TOKEN. Pregunta por los mensajes
 * con long polling, así no necesita una dirección pública; si no hay internet, lo vuelve a intentar
 * cada minuto. Solo lo carga el worker.
 */
import { configuracion } from '../config';
import { crearBot } from '../modulos/clientes/clientes.bot';

const SEGUNDOS_REINTENTO = 60;

/** Arranca el bot y regresa cómo detenerlo. */
export function iniciarBot(): { cerrar: () => Promise<void> } {
  if (!configuracion.telegramToken) {
    console.log('Bot de Telegram apagado: falta TELEGRAM_TOKEN en el .env');
    return { cerrar: async () => undefined };
  }

  const bot = crearBot(configuracion.telegramToken);
  let reintento: NodeJS.Timeout | null = null;
  let cerrando = false;

  const arrancar = () => {
    bot
      .start({ onStart: (info) => console.log(`Bot de Telegram @${info.username} en línea`) })
      .catch((error: Error) => {
        if (cerrando) return;
        console.warn(`El bot de Telegram no se pudo conectar; se reintenta en 1 minuto (${error.message})`);
        reintento = setTimeout(arrancar, SEGUNDOS_REINTENTO * 1000);
      });
  };
  arrancar();

  return {
    cerrar: async () => {
      cerrando = true;
      if (reintento) clearTimeout(reintento);
      if (bot.isRunning()) await bot.stop();
    },
  };
}
