/**
 * Bot de Telegram de la tienda. El cliente llega por el QR del ticket, acepta el aviso de privacidad
 * y comparte su teléfono o escribe su correo; con /baja deja de recibir promociones. El Dueño manda
 * /dueno con el código que le da la API para recibir sus avisos.
 * Solo atiende chats privados. Lo arranca el worker (trabajos/bot.ts).
 */
import { Bot, InlineKeyboard, Keyboard, type Context } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import { esquemaClienteNuevo } from '@pos/compartido';
import { ErrorAplicacion } from '../../comun/errores';
import { claveRedis, redis } from '../../infraestructura/redis';
import { ConfiguracionServicio } from '../configuracion/configuracion';
import { ClientesServicio, type ContactoBot } from './clientes';

// --- En qué paso va cada conversación ---
// Se guarda en Redis y vence a los 10 minutos: si el cliente se tarda más, empieza otra vez con /start.

type Paso = 'ACEPTAR' | 'CONTACTO';
const MINUTOS_PASO = 10;
const clavePaso = (chatId: number) => claveRedis(`bot:paso:${chatId}`);

const leerPaso = async (chatId: number) => (await redis.get(clavePaso(chatId))) as Paso | null;
const fijarPaso = (chatId: number, paso: Paso) =>
  redis.set(clavePaso(chatId), paso, { EX: MINUTOS_PASO * 60 });
const borrarPaso = (chatId: number) => redis.del(clavePaso(chatId));

// --- Textos ---

const aviso = (tienda: string) =>
  `Hola, soy el bot de ${tienda}. Para mandarte promociones guardamos solo tu teléfono o tu correo ` +
  'y la fecha en que aceptas este aviso; no guardamos tus compras. Puedes darte de baja cuando ' +
  'quieras con /baja. ¿Aceptas el aviso de privacidad?';

export const TEXTOS = {
  pideContacto: 'Gracias. Comparte tu teléfono con el botón de abajo o escribe tu correo.',
  noAcepta: 'Entendido, no guardamos ningún dato. Si cambias de opinión, escribe /start.',
  empiece: 'Escribe /start para suscribirte a las promociones.',
  noReconocido: 'No reconocí el dato. Escribe tu correo (por ejemplo ana@correo.mx) o usa el botón.',
  telefonoAjeno: 'Comparte tu propio teléfono con el botón, o escribe tu correo.',
  listo: 'Listo, desde hoy recibes las promociones por aquí. Para darte de baja escribe /baja.',
  yaSuscrito: 'Este chat ya recibe las promociones. Para darte de baja escribe /baja.',
  baja: 'Te diste de baja: ya no recibirás promociones. Si quieres volver, escribe /start.',
  sinSuscripcion: 'Este chat no tiene una suscripción activa. Para suscribirte escribe /start.',
  duenoListo: 'Listo, aquí llegarán los avisos del Dueño, como el resumen del día.',
  duenoInvalido: 'El código no es válido o ya venció. Genere otro en la API y mándelo con /dueno 123456.',
  ayuda:
    'Comandos:\n/start para recibir promociones\n/baja para dejar de recibirlas\n' +
    '/dueno 123456 para que el Dueño reciba sus avisos',
  falla: 'No pudimos atenderte en este momento. Intenta de nuevo en unos minutos.',
};

const sinTeclado = { reply_markup: { remove_keyboard: true as const } };

// --- Contacto ---

/** Teléfono de 10 dígitos: Telegram lo manda con la lada del país (+52 o +521). */
export function telefonoLocal(texto: string): string | null {
  const digitos = texto.replace(/\D/g, '');
  return digitos.length >= 10 ? digitos.slice(-10) : null;
}

/** Lo que el cliente escribe: un correo válido o un teléfono. */
export function contactoDeTexto(texto: string): ContactoBot | null {
  if (texto.includes('@')) {
    const correo = esquemaClienteNuevo.safeParse({ correo: texto, aceptaAviso: true });
    return correo.success && correo.data.correo ? { correo: correo.data.correo } : null;
  }
  const telefono = telefonoLocal(texto);
  return telefono && !/[a-z]/i.test(texto) ? { telefono } : null;
}

// --- Bot ---

/** botInfo se pasa en las pruebas para no tener que preguntarle a Telegram al arrancar. */
export function crearBot(token: string, botInfo?: UserFromGetMe): Bot {
  const bot = new Bot(token, botInfo ? { botInfo } : undefined);
  const privado = bot.chatType('private');
  const clientes = new ClientesServicio();
  const configuracion = new ConfiguracionServicio();

  const vincular = async (ctx: Context, chatId: number, contacto: ContactoBot) => {
    try {
      const { resultado } = await clientes.vincularTelegram(contacto, String(chatId));
      await borrarPaso(chatId);
      await ctx.reply(resultado === 'YA_SUSCRITO' ? TEXTOS.yaSuscrito : TEXTOS.listo, sinTeclado);
    } catch (error) {
      // Si fue una regla de negocio, se le explica al cliente; lo demás se va a bot.catch.
      if (error instanceof ErrorAplicacion) await ctx.reply(error.message, sinTeclado);
      else throw error;
    }
  };

  // Llega desde el QR del ticket: aviso de privacidad con dos botones.
  privado.command('start', async (ctx) => {
    const actual = await clientes.porChat(String(ctx.chat.id));
    if (actual?.suscrito) {
      await ctx.reply(TEXTOS.yaSuscrito);
      return;
    }
    const { nombre } = await configuracion.datosTienda();
    await fijarPaso(ctx.chat.id, 'ACEPTAR');
    await ctx.reply(aviso(nombre), {
      reply_markup: new InlineKeyboard().text('Acepto', 'aceptar').text('No acepto', 'rechazar'),
    });
  });

  // Aceptó el aviso: ahora se le pide su contacto.
  privado.callbackQuery('aceptar', async (ctx) => {
    await ctx.answerCallbackQuery();
    if ((await leerPaso(ctx.chat.id)) !== 'ACEPTAR') {
      await ctx.reply(TEXTOS.empiece);
      return;
    }
    await fijarPaso(ctx.chat.id, 'CONTACTO');
    await ctx.reply(TEXTOS.pideContacto, {
      reply_markup: new Keyboard().requestContact('Compartir mi teléfono').resized().oneTime(),
    });
  });

  // No aceptó: no se guarda nada.
  privado.callbackQuery('rechazar', async (ctx) => {
    await ctx.answerCallbackQuery();
    await borrarPaso(ctx.chat.id);
    await ctx.reply(TEXTOS.noAcepta, sinTeclado);
  });

  // Botón "Compartir mi teléfono": Telegram manda el número ya verificado.
  privado.on('message:contact', async (ctx) => {
    if ((await leerPaso(ctx.chat.id)) !== 'CONTACTO') {
      await ctx.reply(TEXTOS.empiece, sinTeclado);
      return;
    }
    const { contact } = ctx.message;
    const telefono = telefonoLocal(contact.phone_number);
    if (contact.user_id !== ctx.from.id || !telefono) {
      await ctx.reply(TEXTOS.telefonoAjeno);
      return;
    }
    await vincular(ctx, ctx.chat.id, { telefono });
  });

  // Baja por el bot: se retira el consentimiento y se cancelan sus envíos pendientes.
  privado.command('baja', async (ctx) => {
    await borrarPaso(ctx.chat.id);
    const actual = await clientes.porChat(String(ctx.chat.id));
    if (!actual?.suscrito) {
      await ctx.reply(TEXTOS.sinSuscripcion, sinTeclado);
      return;
    }
    await clientes.darDeBaja(actual.cliente.id, null);
    await ctx.reply(TEXTOS.baja, sinTeclado);
  });

  // El Dueño liga su chat con el código de un solo uso.
  privado.command('dueno', async (ctx) => {
    const codigo = ctx.match.trim();
    const vinculado =
      /^\d{6}$/.test(codigo) && (await configuracion.vincularDueno(codigo, String(ctx.chat.id)));
    await ctx.reply(vinculado ? TEXTOS.duenoListo : TEXTOS.duenoInvalido);
  });

  privado.command(['ayuda', 'help'], (ctx) => ctx.reply(TEXTOS.ayuda));

  // Texto libre: si se le pidió, es su correo o teléfono; si no, se le manda la ayuda.
  privado.on('message:text', async (ctx) => {
    if ((await leerPaso(ctx.chat.id)) !== 'CONTACTO') {
      await ctx.reply(TEXTOS.ayuda);
      return;
    }
    const contacto = contactoDeTexto(ctx.message.text.trim());
    if (!contacto) {
      await ctx.reply(TEXTOS.noReconocido);
      return;
    }
    await vincular(ctx, ctx.chat.id, contacto);
  });

  // Si algo falla (por ejemplo Redis o PostgreSQL), se le avisa al cliente y se anota en la consola.
  bot.catch(async ({ ctx, error }) => {
    console.error(`Bot de Telegram: ${(error as Error).message}`);
    await ctx.reply(TEXTOS.falla).catch(() => undefined);
  });

  return bot;
}
