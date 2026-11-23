import { expect } from 'chai';
import type { Update, UserFromGetMe } from 'grammy/types';
import { fuenteDatos } from '../../src/infraestructura/base-datos/fuente';
import { ClientesServicio } from '../../src/modulos/clientes/clientes';
import { contactoDeTexto, crearBot, telefonoLocal, TEXTOS } from '../../src/modulos/clientes/clientes.bot';
import { appDePrueba, appNueva, registrosBitacora } from '../ayuda';

const INFO_BOT = { id: 1, is_bot: true, first_name: 'Tienda', username: 'TiendaBot' } as UserFromGetMe;

interface Llamada {
  metodo: string;
  datos: Record<string, unknown>;
}

/**
 * Bot sin internet: las llamadas a Telegram se guardan en una lista en lugar de enviarse, y los
 * mensajes del cliente se simulan con handleUpdate.
 */
function botDePrueba() {
  const bot = crearBot('123:prueba', INFO_BOT);
  const llamadas: Llamada[] = [];
  bot.api.config.use(async (_anterior, metodo, datos) => {
    llamadas.push({ metodo, datos: datos as Record<string, unknown> });
    return { ok: true, result: true } as never;
  });

  let id = 0;
  const persona = (chat: number) => ({ id: chat, is_bot: false, first_name: 'Ana' });
  const chatPrivado = (chat: number) => ({ id: chat, type: 'private' as const, first_name: 'Ana' });
  const mensaje = (chat: number, contenido: object, tipo = 'private') =>
    bot.handleUpdate({
      update_id: ++id,
      message: {
        message_id: id,
        date: 0,
        chat: tipo === 'private' ? chatPrivado(chat) : { id: chat, type: tipo, title: 'Grupo' },
        from: persona(chat),
        ...contenido,
      },
    } as Update);

  const enviados = () => llamadas.filter((l) => l.metodo === 'sendMessage');
  return {
    llamadas,
    ultimo: () => enviados().at(-1)?.datos ?? {},
    enviados,
    escribe: (chat: number, texto: string, tipo = 'private') => {
      const comando = texto.startsWith('/') ? texto.split(' ')[0]!.length : 0;
      const entidades = comando ? { entities: [{ type: 'bot_command', offset: 0, length: comando }] } : {};
      return mensaje(chat, { text: texto, ...entidades }, tipo);
    },
    comparte: (chat: number, telefono: string, usuarioDelTelefono = chat) =>
      mensaje(chat, { contact: { phone_number: telefono, first_name: 'Ana', user_id: usuarioDelTelefono } }),
    pulsa: (chat: number, boton: string) =>
      bot.handleUpdate({
        update_id: ++id,
        callback_query: {
          id: String(id),
          from: persona(chat),
          chat_instance: 'prueba',
          data: boton,
          message: { message_id: 1, date: 0, chat: chatPrivado(chat), text: 'aviso' },
        },
      } as Update),
  };
}

const clientes = (): Promise<
  { correo: string | null; telefono: string | null; telegram_chat_id: string | null }[]
> => fuenteDatos.query(`SELECT correo, telefono, telegram_chat_id FROM cliente`);
const consentimientos = (): Promise<{ origen: string; revocado_en: Date | null }[]> =>
  fuenteDatos.query(`SELECT origen, revocado_en FROM consentimiento ORDER BY aceptado_en`);

describe('Bot de Telegram', () => {
  it('registra a un cliente nuevo que acepta el aviso y comparte su teléfono', async () => {
    await appNueva();
    const bot = botDePrueba();

    await bot.escribe(500, '/start');
    expect(bot.ultimo().text).to.include('Hola, soy el bot de Tienda de abarrotes');
    expect(JSON.stringify(bot.ultimo().reply_markup)).to.include('Acepto').and.include('No acepto');

    await bot.pulsa(500, 'aceptar');
    expect(bot.llamadas.some((l) => l.metodo === 'answerCallbackQuery')).to.equal(true);
    expect(bot.ultimo().text).to.equal(TEXTOS.pideContacto);
    expect(JSON.stringify(bot.ultimo().reply_markup)).to.include('"request_contact":true');

    // Telegram manda el número con la lada del país; se guarda a 10 dígitos.
    await bot.comparte(500, '+52 1 667 123 4567');
    expect(bot.ultimo().text).to.equal(TEXTOS.listo);

    expect(await clientes()).to.deep.equal([
      { correo: null, telefono: '6671234567', telegram_chat_id: '500' },
    ]);
    expect(await consentimientos()).to.deep.equal([{ origen: 'TELEGRAM', revocado_en: null }]);
    const { registros } = await registrosBitacora({ accion: 'CLIENTE_REGISTRADO' });
    expect(registros).to.have.length(1);
    expect(registros[0]!.usuarioId).to.equal(null);
  });

  it('liga el chat al cliente que ya se registró en la caja, sin duplicarlo', async () => {
    const { api } = await appDePrueba();
    await api.post('/api/v1/clientes').send({ correo: 'ana@correo.mx', aceptaAviso: true }).expect(201);
    const bot = botDePrueba();

    await bot.escribe(500, '/start');
    await bot.pulsa(500, 'aceptar');
    await bot.escribe(500, 'Ana@Correo.MX');
    expect(bot.ultimo().text).to.equal(TEXTOS.yaSuscrito);

    expect(await clientes()).to.deep.equal([
      { correo: 'ana@correo.mx', telefono: null, telegram_chat_id: '500' },
    ]);
    expect(await consentimientos()).to.deep.equal([{ origen: 'CAJA', revocado_en: null }]);

    // Ya suscrito, /start solo lo indica.
    await bot.escribe(500, '/start');
    expect(bot.ultimo().text).to.equal(TEXTOS.yaSuscrito);
  });

  it('si no acepta el aviso no se guarda nada', async () => {
    await appNueva();
    const bot = botDePrueba();

    await bot.escribe(500, '/start');
    await bot.pulsa(500, 'rechazar');
    expect(bot.ultimo().text).to.equal(TEXTOS.noAcepta);

    // El correo ya no se toma: la conversación terminó.
    await bot.escribe(500, 'ana@correo.mx');
    expect(bot.ultimo().text).to.equal(TEXTOS.ayuda);
    expect(await clientes()).to.deep.equal([]);
  });

  it('pide el teléfono propio y rechaza datos que no reconoce', async () => {
    await appNueva();
    const bot = botDePrueba();
    await bot.escribe(500, '/start');
    await bot.pulsa(500, 'aceptar');

    await bot.comparte(500, '6671234567', 999); // contacto de otra persona
    expect(bot.ultimo().text).to.equal(TEXTOS.telefonoAjeno);
    await bot.escribe(500, 'hola');
    expect(bot.ultimo().text).to.equal(TEXTOS.noReconocido);
    await bot.escribe(500, 'ana@');
    expect(bot.ultimo().text).to.equal(TEXTOS.noReconocido);
    expect(await clientes()).to.deep.equal([]);
  });

  it('sin /start no se aceptan el botón ni el contacto', async () => {
    await appNueva();
    const bot = botDePrueba();

    await bot.pulsa(500, 'aceptar');
    expect(bot.ultimo().text).to.equal(TEXTOS.empiece);
    await bot.comparte(500, '6671234567');
    expect(bot.ultimo().text).to.equal(TEXTOS.empiece);
    expect(await clientes()).to.deep.equal([]);
  });

  it('/baja retira el consentimiento; para volver hay que aceptar otra vez', async () => {
    await appNueva();
    const bot = botDePrueba();
    await bot.escribe(500, '/start');
    await bot.pulsa(500, 'aceptar');
    await bot.comparte(500, '6671234567');

    await bot.escribe(500, '/baja');
    expect(bot.ultimo().text).to.equal(TEXTOS.baja);
    const [consentimiento] = await consentimientos();
    expect(consentimiento!.revocado_en).to.be.instanceOf(Date);

    await bot.escribe(500, '/baja');
    expect(bot.ultimo().text).to.equal(TEXTOS.sinSuscripcion);

    // Regresa: acepta de nuevo y queda un consentimiento nuevo.
    await bot.escribe(500, '/start');
    expect(bot.ultimo().text).to.include('¿Aceptas el aviso de privacidad?');
    await bot.pulsa(500, 'aceptar');
    await bot.escribe(500, '667 123 4567');
    expect(bot.ultimo().text).to.equal(TEXTOS.listo);
    const lista = await consentimientos();
    expect(lista.map((c) => c.revocado_en === null)).to.deep.equal([false, true]);
  });

  it('un chat queda ligado a un solo cliente', async () => {
    await appNueva();
    const servicio = new ClientesServicio();
    await servicio.vincularTelegram({ correo: 'ana@correo.mx' }, '500');
    // El mismo chat da otro correo: pasa al cliente nuevo y Ana queda sin chat.
    await servicio.vincularTelegram({ correo: 'beto@correo.mx' }, '500');

    const filas = await fuenteDatos.query(`SELECT correo, telegram_chat_id FROM cliente ORDER BY correo`);
    expect(filas).to.deep.equal([
      { correo: 'ana@correo.mx', telegram_chat_id: null },
      { correo: 'beto@correo.mx', telegram_chat_id: '500' },
    ]);
  });

  it('el Dueño vincula su chat con un código de un solo uso', async () => {
    const { api, empleado } = await appDePrueba();
    await empleado.post('/api/v1/configuracion/telegram-dueno').expect(403);
    const res = await api.post('/api/v1/configuracion/telegram-dueno').expect(201);
    const { codigo } = res.body.data as { codigo: string };
    expect(codigo).to.match(/^\d{6}$/);
    const bot = botDePrueba();

    await bot.escribe(900, `/dueno ${codigo === '000000' ? '111111' : '000000'}`);
    expect(bot.ultimo().text).to.equal(TEXTOS.duenoInvalido);
    await bot.escribe(900, '/dueno');
    expect(bot.ultimo().text).to.equal(TEXTOS.duenoInvalido);

    await bot.escribe(900, `/dueno ${codigo}`);
    expect(bot.ultimo().text).to.equal(TEXTOS.duenoListo);
    const config = await api.get('/api/v1/configuracion').expect(200);
    expect(config.body.data.telegramDuenoVinculado).to.equal(true);
    const [fila] = await fuenteDatos.query(`SELECT telegram_dueno FROM configuracion_tienda`);
    expect(fila.telegram_dueno).to.equal('900');
    const { registros } = await registrosBitacora({ accion: 'TELEGRAM_DUENO_VINCULADO' });
    expect(registros).to.have.length(1);

    // El mismo código ya no sirve.
    await bot.escribe(901, `/dueno ${codigo}`);
    expect(bot.ultimo().text).to.equal(TEXTOS.duenoInvalido);
  });

  it('no contesta en grupos', async () => {
    await appNueva();
    const bot = botDePrueba();
    await bot.escribe(-100, '/start', 'group');
    expect(bot.enviados()).to.deep.equal([]);
  });

  it('reconoce el correo y el teléfono que escribe el cliente', () => {
    expect(telefonoLocal('+52 1 (667) 123-4567')).to.equal('6671234567');
    expect(telefonoLocal('12345')).to.equal(null);
    expect(contactoDeTexto(' ANA@correo.mx ')).to.deep.equal({ correo: 'ana@correo.mx' });
    expect(contactoDeTexto('667-123-4567')).to.deep.equal({ telefono: '6671234567' });
    expect(contactoDeTexto('mi tel 6671234567')).to.equal(null);
    expect(contactoDeTexto('ana@')).to.equal(null);
  });
});
