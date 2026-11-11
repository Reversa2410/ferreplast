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

/** Los dos unicos roles del sistema. */
export const ADMIN = 'administrador';
export const EMPLEADO = 'empleado';

// Las unicas rutas que responden sin sesion. Se nombran por su patron de
// Fastify ('/auth/empleados/:tiendaId'), no por la URL concreta, para que no
// dependa del valor de los parametros.
//
// La lista de tiendas es publica porque la pantalla de ingreso del empleado
// empieza por elegir en cual esta trabajando, y eso pasa antes de tener sesion.
// Expone el nombre de dos locales que tienen un cartel en la puerta.
const RUTAS_PUBLICAS = new Set([
  'GET /salud',
  'GET /tiendas',
  'GET /auth/empleados/:tiendaId',
  'POST /auth/login/pin',
  'POST /auth/login/admin',
  // Los archivos del punto de venta: la pantalla de ingreso tiene que poder
  // cargarse ANTES de tener sesion. No exponen datos: los datos los pide la
  // aplicacion despues, con su token.
  'GET /',
  'GET /app',
  'GET /app/*',
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
 *   app.get('/reportes/resumen', { preHandler: exigirRol(ADMIN) }, ...)
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
 * El administrador ve y opera sobre las dos. El empleado, solo sobre la que
 * eligio al entrar: sin esto, cualquier empleado podria descontar stock de la
 * otra tienda con solo cambiar un numero en la peticion.
 *
 * La tienda del empleado sale de su SESION, no de su ficha: desde que puede
 * estar asignado a las dos (USUARIO_TIENDA), lo que manda es la que eligio en
 * este turno. Que este asignado a la otra no le sirve mientras no vuelva a
 * entrar eligiendola.
 *
 * La comparacion es entre numeros a proposito: el id llega como texto cuando
 * viene de la URL, y 1 === '1' es falso. Un alcance que falla hacia el lado
 * permisivo seria un agujero; este falla hacia el lado restrictivo, pero
 * convertir explicitamente evita las dos cosas.
 */
export function puedeOperarEn(usuario, tiendaId) {
  if (usuario.rol === ADMIN) return true;
  if (usuario.tienda_id == null || tiendaId == null) return false;
  return Number(usuario.tienda_id) === Number(tiendaId);
}
