// =============================================================================
// Ingreso y salida
//
// Dos puertas distintas porque son dos situaciones distintas:
//
//   * El EMPLEADO esta de pie frente al mostrador con un cliente esperando.
//     Elige la tienda, toca su nombre en una lista y teclea 4 digitos. La
//     sesion dura el turno.
//
//   * El ADMINISTRADOR mira numeros desde una computadora. Email y
//     contrasenia, sesion corta.
//
// Ambas terminan en lo mismo: una fila en SESION y un token para el cliente.
//
// POR QUE EL EMPLEADO ELIGE LA TIENDA AL ENTRAR:
// Hay empleados que trabajan en los dos locales (tabla USUARIO_TIENDA). "De
// que tienda es" no es, entonces, una propiedad de la persona sino de su turno.
// Se decide una vez, al ingresar, y queda grabada en la sesion: todo lo que
// haga despues pertenece a esa tienda sin que cada peticion tenga que decirlo
// -- y sin que pueda mentir al respecto.
// =============================================================================

import {
  EsquemaLoginAdmin,
  EsquemaLoginPin,
  EsquemaTiendaEnUrl,
  formatearErrores,
} from '../validacion.mjs';
import { verificar } from '../auth/password.mjs';
import { crearSesion, revocarSesion, revocarSesionesDe } from '../auth/sesiones.mjs';
import { registrarIntento, estaBloqueado, limpiarFallos } from '../auth/intentos.mjs';
import { ADMIN, EMPLEADO } from '../auth/guardia.mjs';

// Un unico mensaje para todos los fallos de credenciales.
//
// POR QUE NO SE DICE "ese email no existe" NI "la contrasenia es incorrecta":
// porque distinguirlos regala la mitad del trabajo. Con "el email no existe" se
// puede averiguar que cuentas hay probando direcciones, y recien despues
// concentrarse en adivinar la clave de una que si existe.
const CREDENCIAL_INVALIDA = 'credenciales incorrectas';

// Hash que no corresponde a ninguna clave, para gastar el mismo tiempo cuando
// el usuario no existe.
//
// POR QUE: sin esto, un usuario inexistente responde al instante y uno real
// tarda los ~100 ms de scrypt. Midiendo el tiempo de respuesta se puede
// averiguar que identificadores existen sin acertar una sola clave.
const HASH_DE_RELLENO = 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA';

/**
 * Respuesta comun de un ingreso correcto.
 *
 * Nunca incluye el hash ni nada derivado de la clave. Solo lo que el cliente
 * necesita para dibujar su pantalla: quien es, que rol tiene y en que tienda
 * esta trabajando.
 */
function respuestaSesion(usuario, sesion, tiendaId) {
  return {
    token: sesion.token,
    expira_en: sesion.expira_en,
    usuario: {
      id: usuario.id,
      nombre: usuario.nombre,
      rol: usuario.rol,
      negocio_id: usuario.negocio_id,
      // null para el administrador: opera sobre las dos tiendas.
      tienda_id: tiendaId,
    },
  };
}

export default async function rutasAuth(app, { db }) {
  // ---------------------------------------------------------------------------
  // GET /tiendas                          [PUBLICA]
  //
  // El primer paso de la pantalla de ingreso del empleado. Es publica por
  // necesidad: hay que poder elegir la tienda antes de haber entrado.
  //
  // Devuelve solo lo que hace falta para dibujar los dos botones. Lo que se
  // expone es el nombre de dos locales que tienen un cartel en la puerta.
  // ---------------------------------------------------------------------------
  app.get('/tiendas', async () => {
    const { rows } = await db.query(
      `SELECT id, nombre, tipo, prefijo
         FROM TIENDA
        WHERE activo = 1
        ORDER BY nombre`,
    );
    return { tiendas: rows };
  });

  // ---------------------------------------------------------------------------
  // GET /auth/empleados/:tiendaId         [PUBLICA]
  //
  // La lista de nombres que la tablet muestra para tocar antes de teclear el
  // PIN. Publica por lo mismo que la anterior.
  //
  // Devuelve SOLO id y nombre. Nada de email, rol ni hash. Lo que se expone es
  // que en esa tienda trabaja alguien llamado "Maria", que es exactamente lo
  // que ve cualquiera que entre al local y lea el delantal. El PIN sigue siendo
  // lo unico que deja entrar, y lo protege el limite de intentos.
  //
  // Se filtra por rol = 'empleado' y no solo por "tiene PIN": el esquema no
  // impide que un administrador tenga PIN tambien, y la lista del mostrador no
  // tiene por que nombrar a la duenia.
  // ---------------------------------------------------------------------------
  app.get('/auth/empleados/:tiendaId', async (peticion, respuesta) => {
    const params = EsquemaTiendaEnUrl.safeParse(peticion.params);
    if (!params.success) {
      return respuesta.code(400).send({ error: 'identificador de tienda invalido' });
    }

    const { rows } = await db.query(
      `SELECT u.id, u.nombre
         FROM Usuario        u
         JOIN USUARIO_TIENDA ut ON ut.usuario_id = u.id
         JOIN TIENDA         t  ON t.id          = ut.tienda_id
        WHERE ut.tienda_id = @tienda_id
          AND u.activo     = 1
          AND t.activo     = 1
          AND u.rol        = @rol
          AND u.pin_hash IS NOT NULL
        ORDER BY u.nombre`,
      { tienda_id: params.data.tiendaId, rol: EMPLEADO },
    );

    if (rows.length === 0) {
      // Puede ser una tienda inexistente o una sin empleados cargados. No se
      // distingue: tampoco hace falta, y no invita a probar identificadores.
      return respuesta.code(404).send({ error: 'tienda no encontrada o sin empleados' });
    }

    return { empleados: rows };
  });

  // ---------------------------------------------------------------------------
  // POST /auth/login/pin                  [PUBLICA]
  //
  // Ingreso del empleado desde la tablet.
  // ---------------------------------------------------------------------------
  app.post('/auth/login/pin', async (peticion, respuesta) => {
    const validacion = EsquemaLoginPin.safeParse(peticion.body ?? {});
    if (!validacion.success) {
      return respuesta.code(400).send({
        error: 'datos de ingreso invalidos',
        detalles: formatearErrores(validacion.error),
      });
    }

    const { usuario_id, tienda_id, pin, dispositivo_id } = validacion.data;
    const ip = peticion.ip;

    // El identificador de la ventana de intentos es el usuario, no la IP: en la
    // tienda todas las tablets salen por la misma conexion, asi que contar por
    // IP bloquearia a los companieros de quien se equivoco.
    const bloqueo = await estaBloqueado(db, usuario_id);
    if (bloqueo.bloqueado) {
      return respuesta.code(429).send({
        error: `demasiados intentos fallidos; espere ${bloqueo.ventana_minutos} minutos`,
      });
    }

    // La asignacion a la tienda se resuelve en la misma consulta que las
    // credenciales, pero se COMPRUEBA despues de verificar el PIN: decir "usted
    // no trabaja ahi" antes de validar la clave confirmaria que ese usuario
    // existe a quien solo probo un numero.
    const { rows } = await db.query(
      `SELECT u.id, u.nombre, u.rol, u.negocio_id, u.pin_hash,
              CAST(CASE WHEN EXISTS (
                  SELECT 1
                    FROM USUARIO_TIENDA ut
                    JOIN TIENDA t ON t.id = ut.tienda_id
                   WHERE ut.usuario_id = u.id
                     AND ut.tienda_id  = @tienda_id
                     AND t.activo      = 1
              ) THEN 1 ELSE 0 END AS BIT) AS asignado
         FROM Usuario u
        WHERE u.id = @usuario_id
          AND u.activo = 1
          AND u.pin_hash IS NOT NULL`,
      { usuario_id, tienda_id },
    );
    const usuario = rows[0];

    const correcto = await verificar(pin, usuario?.pin_hash ?? HASH_DE_RELLENO);

    if (!usuario || !correcto) {
      await registrarIntento(db, { identificador: usuario_id, exitoso: false, ip }, peticion.log);
      return respuesta.code(401).send({ error: CREDENCIAL_INVALIDA });
    }

    if (!usuario.asignado) {
      // 403 y no 401: la clave estaba bien. El problema es la tienda, y
      // reintentar el PIN no lo arregla.
      await registrarIntento(db,
        { identificador: usuario_id, tiendaId: tienda_id, exitoso: false, ip }, peticion.log);
      return respuesta.code(403).send({ error: 'no esta asignado a esa tienda' });
    }

    await registrarIntento(db,
      { identificador: usuario_id, tiendaId: tienda_id, exitoso: true, ip }, peticion.log);
    await limpiarFallos(db, usuario_id, peticion.log);

    const sesion = await crearSesion(db, usuario, {
      dispositivoId: dispositivo_id ?? null,
      tiendaId: tienda_id,
    });
    await db.query(
      'UPDATE Usuario SET ultimo_acceso = SYSUTCDATETIME() WHERE id = @id',
      { id: usuario.id },
    );

    return respuestaSesion(usuario, sesion, tienda_id);
  });

  // ---------------------------------------------------------------------------
  // POST /auth/login/admin                [PUBLICA]
  //
  // Ingreso de la duenia desde el panel web.
  // ---------------------------------------------------------------------------
  app.post('/auth/login/admin', async (peticion, respuesta) => {
    const validacion = EsquemaLoginAdmin.safeParse(peticion.body ?? {});
    if (!validacion.success) {
      return respuesta.code(400).send({
        error: 'datos de ingreso invalidos',
        detalles: formatearErrores(validacion.error),
      });
    }

    // El email se normaliza a minusculas: quien escribe Admin@... y admin@...
    // tiene que caer en la misma cuenta, y tambien en la misma ventana de
    // intentos fallidos (si no, alternar mayusculas multiplicaria los intentos).
    const email = validacion.data.email.toLowerCase();
    const { password } = validacion.data;
    const ip = peticion.ip;

    const bloqueo = await estaBloqueado(db, email);
    if (bloqueo.bloqueado) {
      return respuesta.code(429).send({
        error: `demasiados intentos fallidos; espere ${bloqueo.ventana_minutos} minutos`,
      });
    }

    const { rows } = await db.query(
      `SELECT id, nombre, rol, negocio_id, password_hash
         FROM Usuario
        WHERE LOWER(email) = @email
          AND activo = 1
          AND rol    = @rol
          AND password_hash IS NOT NULL`,
      { email, rol: ADMIN },
    );
    const usuario = rows[0];

    const correcto = await verificar(password, usuario?.password_hash ?? HASH_DE_RELLENO);

    if (!usuario || !correcto) {
      await registrarIntento(db, { identificador: email, exitoso: false, ip }, peticion.log);
      return respuesta.code(401).send({ error: CREDENCIAL_INVALIDA });
    }

    await registrarIntento(db, { identificador: email, exitoso: true, ip }, peticion.log);
    await limpiarFallos(db, email, peticion.log);

    // Sin tienda: el administrador opera sobre las dos.
    const sesion = await crearSesion(db, usuario);
    await db.query(
      'UPDATE Usuario SET ultimo_acceso = SYSUTCDATETIME() WHERE id = @id',
      { id: usuario.id },
    );

    return respuestaSesion(usuario, sesion, null);
  });

  // ---------------------------------------------------------------------------
  // GET /auth/yo                          [requiere sesion]
  //
  // Quien soy. La usa el cliente al arrancar para saber si el token que tenia
  // guardado sigue sirviendo, en lugar de descubrirlo con un 401 a mitad de una
  // venta.
  // ---------------------------------------------------------------------------
  app.get('/auth/yo', async (peticion) => {
    const u = peticion.usuario;
    return {
      usuario: {
        id: u.id,
        nombre: u.nombre,
        rol: u.rol,
        negocio_id: u.negocio_id,
        tienda_id: u.tienda_id,
      },
      expira_en: u.expira_en,
    };
  });

  // ---------------------------------------------------------------------------
  // POST /auth/salir                      [requiere sesion]
  // ---------------------------------------------------------------------------
  app.post('/auth/salir', async (peticion) => {
    await revocarSesion(db, peticion.token);
    return { cerrada: true };
  });

  // ---------------------------------------------------------------------------
  // POST /auth/salir/todo                 [requiere sesion]
  //
  // Cierra todas las sesiones del usuario. Es el boton para cuando se pierde
  // una tablet: se entra desde cualquier otro lado y se corta todo.
  // ---------------------------------------------------------------------------
  app.post('/auth/salir/todo', async (peticion) => {
    const cerradas = await revocarSesionesDe(db, peticion.usuario.id);
    return { cerradas };
  });
}
