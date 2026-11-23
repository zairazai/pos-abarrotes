import { expect } from 'chai';
import { esquemaClienteNuevo } from '../../src/esquemas/clientes';

describe('Esquema de cliente', () => {
  it('guarda el correo en minúsculas y el teléfono solo con dígitos', () => {
    const r = esquemaClienteNuevo.parse({
      correo: ' Ana@Correo.MX ',
      telefono: '(667) 123-4567',
      aceptaAviso: true,
    });
    expect(r).to.deep.equal({ correo: 'ana@correo.mx', telefono: '6671234567', aceptaAviso: true });
  });

  it('basta el correo o el teléfono, pero al menos uno', () => {
    expect(esquemaClienteNuevo.safeParse({ correo: 'a@b.mx', aceptaAviso: true }).success).to.equal(true);
    expect(esquemaClienteNuevo.safeParse({ telefono: '6671234567', aceptaAviso: true }).success).to.equal(
      true,
    );
    const nada = esquemaClienteNuevo.safeParse({ aceptaAviso: true });
    expect(nada.error!.issues[0]!.message).to.equal('Indique el correo o el teléfono');
  });

  it('rechaza un correo inválido, un teléfono corto y que falte la respuesta al aviso', () => {
    expect(esquemaClienteNuevo.safeParse({ correo: 'no-es', aceptaAviso: true }).success).to.equal(false);
    const corto = esquemaClienteNuevo.safeParse({ telefono: '123', aceptaAviso: true });
    expect(corto.error!.issues[0]!.path).to.deep.equal(['telefono']);
    expect(esquemaClienteNuevo.safeParse({ correo: 'a@b.mx' }).success).to.equal(false);
  });
});
