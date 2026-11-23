/**
 * Salida de correos (Nodemailer) y mensajes de Telegram (grammY). Si el .env no trae los datos, el
 * envío se simula y solo se anota en la consola; con SMTP_HOST o TELEGRAM_TOKEN sale de verdad.
 */
import { Api } from 'grammy';
import nodemailer, { type Transporter } from 'nodemailer';
import { configuracion } from '../config';

let transporte: Transporter | null = null;
let telegram: Api | null = null;

export const mensajeria = {
  async correo(destino: string, asunto: string, texto: string): Promise<void> {
    const { host, puerto, usuario, clave, remitente } = configuracion.smtp;
    if (!host) {
      console.log(`[correo simulado] ${destino}: ${asunto}`);
      return;
    }
    transporte ??= nodemailer.createTransport({
      host,
      port: puerto,
      auth: usuario ? { user: usuario, pass: clave } : undefined,
    });
    await transporte.sendMail({ from: remitente, to: destino, subject: asunto, text: texto });
  },

  async telegram(chatId: string, texto: string): Promise<void> {
    if (!configuracion.telegramToken) {
      console.log(`[telegram simulado] ${chatId}: ${texto}`);
      return;
    }
    telegram ??= new Api(configuracion.telegramToken);
    await telegram.sendMessage(chatId, texto);
  },
};

/** Dice si algún canal sale de verdad; solo entonces importa si hay internet. */
export const hayEnvioReal = () => !!(configuracion.smtp.host || configuracion.telegramToken);
