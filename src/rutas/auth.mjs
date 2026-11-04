// =============================================================================
// Ingreso y salida
//
// Dos puertas distintas porque son dos situaciones distintas:
//
//   * El EMPLEADO esta de pie frente al mostrador con un cliente esperando.
//     Toca su nombre en una lista y teclea 4 digitos. La sesion dura el turno.
//
//   * El ADMIN mira numeros desde una computadora. Email y contrasenia, sesion
//     corta.
//
// Ambas terminan en lo mismo: una fila en `sesiones` y un token para el cliente.
// =============================================================================

import {
  EsquemaLoginAdmin,
  EsquemaLoginPin,
  formatearErrores,
} from '../validacion.mjs';
import { verificar } from '../auth/password.mjs';
import { crearSesion, revocarSesion, revocarSesionesDe } from '../auth/sesiones.mjs';
import { registrarIntento, estaBloqueado, limpiarFallos } from '../auth/intentos.mjs';

// Un unico mensaje para todos los fallos de credenciales.
//
// POR QUE NO SE DICE "ese email no existe" NI "la contrasenia es incorrecta":
// porque distinguirlos regala la mitad del trabajo. Con "el email no existe" se
// puede averiguar que cuentas hay probando direcciones, y recien despues
// concentrarse en adivinar la clave de una que si existe.
const CREDENCIAL_INVALIDA = 'credenciales incorrectas';

/**
 * Respuesta comun de un ingreso correcto.
 *
 * Nunca incluye el hash ni nada derivado de la clave. Solo lo que el cliente
 * necesita para dibujar su pantalla: quien es, que rol tiene y de que tienda.
 */
function respuestaSesion(usuario, sesion) {
  return {
    token: sesion.token,
    expira_en: sesion.expira_en,
    usuario: {
      id:         usuario.id,
      nombre:     usuario.nombre,
      rol:        usuario.rol,
      tienda_id:  usuario.tienda_id,
      negocio_id: usuario.negocio_id,
    },
  };
}

export default async function rutasAuth(app, { db }) {
  // ---------------------------------------------------------------------------
  // GET /auth/empleados/:tiendaId        [PUBLICA]
  //
  // La lista de nombres que la tablet muestra para tocar antes de teclear el
  // PIN. Es publica por necesidad: hay que poder dibujar la pantalla de ingreso
  // antes de haber ingresado.
  //
  // Devuelve SOLO id y nombre. Nada de email, rol ni hash. Lo que se expone es
  // que en esa tienda trabaja alguien llamado "Maria", que es exactamente lo
  // que ve cualquiera que entre al local y lea el delantal. El PIN sigue siendo
  // lo unico que deja entrar, y lo protege el limite de intentos.
  // ---------------------------------------------------------------------------
  app.get('/auth/empleados/:tiendaId', async (peticion, respuesta) => {
    const { tiendaId } = peticion.params;

    const { rows } = await db.query(
      `SELECT u.id, u.nombre
         FROM usuarios u
         JOIN tiendas t ON t.id = u.tienda_id
        WHERE u.tienda_id = $1
          AND u.activo
          AND t.activo
          AND u.pin_hash IS NOT NULL
        ORDER BY u.nombre`,
      [tiendaId],
    );

    if (rows.length === 0) {
      // Puede ser una tienda inexistente o una sin empleados cargados. No se
      // distingue: tampoco hace falta, y no invita a probar identificadores.
      return respuesta.code(404).send({ error: 'tienda no encontrada o sin empleados' });
    }

    return { empleados: rows };
  });

  // ---------------------------------------------------------------------------
  // POST /auth/login/pin                 [PUBLICA]
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

    const { usuario_id, pin, dispositivo_id } = validacion.data;
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

    const { rows } = await db.query(
      `SELECT id, nombre, rol, tienda_id, negocio_id, pin_hash
         FROM usuarios
        WHERE id = $1 AND activo AND pin_hash IS NOT NULL`,
      [usuario_id],
    );
    const usuario = rows[0];

    // Si el usuario no existe igual se verifica contra un hash de mentira.
    //
    // POR QUE: sin esto, un usuario inexistente responde al instante y uno real
    // tarda los ~100 ms de scrypt. Midiendo el tiempo de respuesta se puede
    // averiguar que identificadores existen sin acertar un solo PIN.
    const hashAComparar = usuario?.pin_hash ?? 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA';
    const correcto = await verificar(pin, hashAComparar);

    if (!usuario || !correcto) {
      await registrarIntento(db, { identificador: usuario_id, exitoso: false, ip }, peticion.log);
      return respuesta.code(401).send({ error: CREDENCIAL_INVALIDA });
    }

    await registrarIntento(db,
      { identificador: usuario_id, tiendaId: usuario.tienda_id, exitoso: true, ip }, peticion.log);
    await limpiarFallos(db, usuario_id, peticion.log);

    const sesion = await crearSesion(db, usuario, dispositivo_id ?? null);
    await db.query('UPDATE usuarios SET ultimo_acceso = NOW() WHERE id = $1', [usuario.id]);

    return respuestaSesion(usuario, sesion);
  });

  // ---------------------------------------------------------------------------
  // POST /auth/login/admin               [PUBLICA]
  //
  // Ingreso del duenio desde el panel web.
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
      `SELECT id, nombre, rol, tienda_id, negocio_id, password_hash
         FROM usuarios
        WHERE LOWER(email) = $1 AND activo AND password_hash IS NOT NULL`,
      [email],
    );
    const usuario = rows[0];

    const hashAComparar = usuario?.password_hash ?? 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA';
    const correcto = await verificar(password, hashAComparar);

    if (!usuario || !correcto) {
      await registrarIntento(db, { identificador: email, exitoso: false, ip }, peticion.log);
      return respuesta.code(401).send({ error: CREDENCIAL_INVALIDA });
    }

    await registrarIntento(db, { identificador: email, exitoso: true, ip }, peticion.log);
    await limpiarFallos(db, email, peticion.log);

    const sesion = await crearSesion(db, usuario, null);
    await db.query('UPDATE usuarios SET ultimo_acceso = NOW() WHERE id = $1', [usuario.id]);

    return respuestaSesion(usuario, sesion);
  });

  // ---------------------------------------------------------------------------
  // GET /auth/yo                         [requiere sesion]
  //
  // Quien soy. La usa el cliente al arrancar para saber si el token que tenia
  // guardado sigue sirviendo, en lugar de descubrirlo con un 401 a mitad de una
  // venta.
  // ---------------------------------------------------------------------------
  app.get('/auth/yo', async (peticion) => {
    const u = peticion.usuario;
    return {
      usuario: {
        id: u.id, nombre: u.nombre, rol: u.rol,
        tienda_id: u.tienda_id, negocio_id: u.negocio_id,
      },
      expira_en: u.expira_en,
    };
  });

  // ---------------------------------------------------------------------------
  // POST /auth/salir                     [requiere sesion]
  // ---------------------------------------------------------------------------
  app.post('/auth/salir', async (peticion) => {
    await revocarSesion(db, peticion.token);
    return { cerrada: true };
  });

  // ---------------------------------------------------------------------------
  // POST /auth/salir/todo                [requiere sesion]
  //
  // Cierra todas las sesiones del usuario. Es el boton para cuando se pierde
  // una tablet: se entra desde cualquier otro lado y se corta todo.
  // ---------------------------------------------------------------------------
  app.post('/auth/salir/todo', async (peticion) => {
    const cerradas = await revocarSesionesDe(db, peticion.usuario.id);
    return { cerradas };
  });
}
