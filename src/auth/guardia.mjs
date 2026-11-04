// =============================================================================
// Guardia de las rutas
//
// Un hook que corre ANTES de cada peticion, sin excepcion. Busca el token,
// resuelve el usuario y lo deja en `peticion.usuario` para que las rutas lo
// usen sin repetir la verificacion.
//
// POR QUE SE CIERRA TODO Y SE ABRE UNA LISTA, Y NO AL REVES:
// La alternativa es marcar cada ruta que necesita proteccion. Es la misma
// cantidad de codigo y falla distinto: olvidarse de marcar una ruta nueva la
// deja ABIERTA, y nada avisa. Con este orden, olvidarse la deja CERRADA -- se
// nota en la primera prueba, y el error no es un agujero sino una molestia.
// =============================================================================

import { usuarioDeToken } from './sesiones.mjs';

// Las unicas rutas que responden sin sesion. Se nombran por su patron de
// Fastify ('/auth/empleados/:tiendaId'), no por la URL concreta, para que no
// dependa del valor de los parametros.
const RUTAS_PUBLICAS = new Set([
  'GET /salud',
  'GET /auth/empleados/:tiendaId',
  'POST /auth/login/pin',
  'POST /auth/login/admin',
]);

/**
 * Extrae el token de la cabecera `Authorization: Bearer <token>`.
 *
 * Se usa esa cabecera y no una cookie porque el cliente es una PWA que puede
 * estar servida desde otro origen que la API, y porque asi no hay nada que
 * el navegador mande solo: sin cookies automaticas no existe la clase de
 * ataque en que un sitio ajeno dispara peticiones en nombre del usuario (CSRF).
 */
function tokenDeCabecera(peticion) {
  const cabecera = peticion.headers.authorization;
  if (typeof cabecera !== 'string') return null;

  const [esquema, valor] = cabecera.split(' ');
  if (!valor || esquema.toLowerCase() !== 'bearer') return null;

  return valor.trim() || null;
}

/**
 * Registra el hook de autenticacion en la aplicacion.
 */
export function registrarGuardia(app, db) {
  app.decorateRequest('usuario', null);
  app.decorateRequest('token', null);

  app.addHook('onRequest', async (peticion, respuesta) => {
    // routeOptions.url es el patron de la ruta. Si viene vacio, la URL no
    // corresponde a ninguna ruta registrada y Fastify respondera 404; no hay
    // nada que proteger.
    const patron = peticion.routeOptions?.url;
    if (!patron) return;

    if (RUTAS_PUBLICAS.has(`${peticion.method} ${patron}`)) return;

    const token = tokenDeCabecera(peticion);
    if (!token) {
      return respuesta.code(401).send({ error: 'falta la cabecera Authorization' });
    }

    const usuario = await usuarioDeToken(db, token);
    if (!usuario) {
      // Un solo mensaje para token inexistente, caducado, revocado y usuario
      // dado de baja: al cliente le sirve lo mismo en los cuatro casos (volver
      // a entrar) y no hace falta contarle cual fue.
      return respuesta.code(401).send({ error: 'sesion invalida o expirada' });
    }

    peticion.usuario = usuario;
    peticion.token = token;
  });
}

// -----------------------------------------------------------------------------
// Ayudas de autorizacion
//
// Autenticar es saber QUIEN es. Autorizar es saber QUE puede hacer. El hook de
// arriba hace lo primero; esto hace lo segundo, y se aplica ruta por ruta
// porque depende de lo que cada una haga.
// -----------------------------------------------------------------------------

/**
 * preHandler que exige uno de los roles indicados.
 *
 *   app.get('/reportes/resumen', { preHandler: exigirRol('admin') }, ...)
 */
export function exigirRol(...roles) {
  return async (peticion, respuesta) => {
    if (!roles.includes(peticion.usuario.rol)) {
      // 403 y no 401: el usuario esta identificado correctamente, lo que pasa
      // es que no le corresponde. Reintentar el ingreso no lo arreglaria.
      return respuesta.code(403).send({ error: 'no tiene permiso para esta operacion' });
    }
  };
}

/**
 * Dice si el usuario puede operar sobre una tienda.
 *
 * El admin ve y opera sobre las dos. El empleado y el encargado, solo sobre la
 * suya: sin esto, cualquier empleado podria descontar stock de la otra tienda
 * con solo cambiar un identificador en la peticion.
 */
export function puedeOperarEn(usuario, tiendaId) {
  if (usuario.rol === 'admin') return true;
  return usuario.tienda_id != null && usuario.tienda_id === tiendaId;
}
