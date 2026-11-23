/**
 * Configuración general de Swagger (/api-docs): el registro donde cada módulo apunta sus rutas, la
 * generación del documento OpenAPI y las opciones de la página. Es pura documentación.
 */
import { OpenAPIRegistry, OpenApiGeneratorV3, extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

extendZodWithOpenApi(z);

export function crearRegistro(): OpenAPIRegistry {
  const registro = new OpenAPIRegistry();
  // Token de acceso que entrega POST /auth/pin.
  registro.registerComponent('securitySchemes', 'tokenAcceso', {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'JWT',
  });
  return registro;
}

/** Documento OpenAPI 3.0 generado a partir de los esquemas Zod de las rutas. */
export function generarEspecificacion(registro: OpenAPIRegistry, version: string) {
  return new OpenApiGeneratorV3(registro.definitions).generateDocument({
    openapi: '3.0.3',
    info: {
      title: 'API del punto de venta de abarrotes',
      version,
      description:
        'API local del POS. Montos y pesos viajan como texto decimal ("18.50"). ' +
        'Los errores siguen RFC 7807 (application/problem+json) con mensajes en español.',
    },
    servers: [{ url: '/' }],
  });
}

interface RespuestaSwagger {
  url: string;
  status: number;
  body?: { data?: { tokenAcceso?: string } };
}

interface InterfazSwagger {
  preauthorizeApiKey(esquema: string, valor: string): void;
  authActions: { logout(esquemas: string[]): void };
}

/**
 * Opciones de Swagger UI. Esta función corre en el navegador: al iniciar sesión o renovar, agarra el
 * token de la respuesta y con él autoriza las demás rutas; al cerrar sesión, lo quita.
 */
export const opcionesSwaggerUi = {
  customSiteTitle: 'API del POS',
  swaggerOptions: {
    persistAuthorization: true,
    responseInterceptor: function (res: RespuestaSwagger) {
      const ui = (globalThis as unknown as { ui?: InterfazSwagger }).ui;
      if (ui && res.status === 200 && /\/api\/v1\/auth\/(pin|renovar)$/.test(res.url)) {
        const token = res.body?.data?.tokenAcceso;
        if (token) ui.preauthorizeApiKey('tokenAcceso', token);
      }
      if (ui && res.status === 200 && /\/api\/v1\/auth\/salir$/.test(res.url)) {
        ui.authActions.logout(['tokenAcceso']);
      }
      return res;
    },
  },
};
