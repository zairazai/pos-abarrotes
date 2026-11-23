/** Lo que se valida de los clientes: solo correo y/o teléfono, y que hayan aceptado los avisos. */
import { z } from 'zod';

const correo = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email('Debe ser un correo válido').max(254, 'Debe tener como máximo 254 caracteres'));

const telefono = z
  .string()
  .transform((v) => v.replace(/\D/g, ''))
  .pipe(z.string().regex(/^\d{10,15}$/, 'Debe tener de 10 a 15 dígitos'));

/** Lo que se captura en la caja; aceptaAviso es si dijo que sí al aviso de privacidad. */
export const esquemaClienteNuevo = z
  .strictObject({
    correo: correo.optional(),
    telefono: telefono.optional(),
    aceptaAviso: z.boolean({ error: 'Indique si el cliente acepta el aviso de privacidad' }),
  })
  .refine((c) => c.correo || c.telefono, { message: 'Indique el correo o el teléfono' });

/** Buscar por correo o teléfono. */
export const esquemaBusquedaCliente = z.object({
  contacto: z.string({ error: 'Es obligatorio' }).trim().min(1, 'Es obligatorio'),
});

// --- Respuestas ---

export const esquemaCliente = z.object({
  id: z.string(),
  correo: z.string().nullable(),
  telefono: z.string().nullable(),
  telegramVinculado: z.boolean(),
  suscrito: z.boolean(), // si sigue aceptando avisos
  creadoEn: z.string(),
});

export type ClienteNuevo = z.infer<typeof esquemaClienteNuevo>;
export type BusquedaCliente = z.infer<typeof esquemaBusquedaCliente>;
export type Cliente = z.infer<typeof esquemaCliente>;
