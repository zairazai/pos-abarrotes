import { expect } from 'chai';
import { esquemaConfiguracionModificada } from '../../src/esquemas/configuracion';

const valida = {
  nombre: 'Abarrotes Don Pepe',
  direccion: 'Av. Obregón 123, Culiacán',
  telefono: '667 123 4567',
  politicaDevolucion: 'Devoluciones el mismo día presentando este ticket.',
  enlaceBot: 'https://t.me/AbarrotesDonPepeBot',
};

describe('Esquema de la configuración de la tienda', () => {
  it('acepta los datos completos y quita espacios', () => {
    const r = esquemaConfiguracionModificada.parse({ ...valida, nombre: '  Abarrotes Don Pepe ' });
    expect(r.nombre).to.equal('Abarrotes Don Pepe');
  });

  it('exige el nombre de la tienda', () => {
    const r = esquemaConfiguracionModificada.safeParse({ ...valida, nombre: '   ' });
    expect(r.success).to.equal(false);
    expect(r.error!.issues[0]!.path).to.deep.equal(['nombre']);
  });

  it('exige la política de devolución, que siempre va en el ticket', () => {
    expect(esquemaConfiguracionModificada.safeParse({ ...valida, politicaDevolucion: '' }).success).to.equal(
      false,
    );
  });

  it('dirección, teléfono y enlace del bot son opcionales y quedan vacíos', () => {
    const r = esquemaConfiguracionModificada.parse({
      nombre: valida.nombre,
      politicaDevolucion: valida.politicaDevolucion,
    });
    expect(r).to.include({ direccion: '', telefono: '', enlaceBot: '' });
  });

  it('el teléfono solo admite dígitos, espacios, guiones, paréntesis y +', () => {
    expect(
      esquemaConfiguracionModificada.safeParse({ ...valida, telefono: '(667) 123-45-67' }).success,
    ).to.equal(true);
    expect(esquemaConfiguracionModificada.safeParse({ ...valida, telefono: 'llamar' }).success).to.equal(
      false,
    );
  });

  it('el enlace del bot debe ser de Telegram', () => {
    expect(
      esquemaConfiguracionModificada.safeParse({ ...valida, enlaceBot: 'https://ejemplo.com/bot' }).success,
    ).to.equal(false);
  });

  it('no acepta campos desconocidos', () => {
    expect(esquemaConfiguracionModificada.safeParse({ ...valida, logo: 'x.png' }).success).to.equal(false);
  });
});
