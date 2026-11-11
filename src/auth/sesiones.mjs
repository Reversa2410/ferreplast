// =============================================================================
// Sesiones: crear, verificar y revocar
//
// El token que recibe el cliente son 32 bytes al azar en base64url. No lleva
// informacion adentro: es una llave opaca que solo sirve para encontrar la fila
// correspondiente en la tabla SESION.
//
// En la base NO se guarda el token sino su SHA-256. El razonamiento completo
// esta en el comentario de la tabla, en db/schema.sql.
// =============================================================================

import { randomBytes, createHash } from 'node:crypto';

// Cuanto dura una sesion segun quien entra, en minutos.
//
// El empleado trabaja todo el dia en la misma tablet, muchas veces sin senial:
// pedirle el PIN cada hora seria inusable, y si la sesion caduca estando sin
// conexion no puede renovarla. Doce horas cubre un turno completo.
//
// El administrador entra desde el navegador a mirar numeros, posiblemente desde
// una computadora compartida. Dos horas.
const MINUTOS = {
  empleado: 12 * 60,
  administrador: 2 * 60,
};

/** SHA-256 en hexadecimal: 64 caracteres, que es el largo de la columna. */
export function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Abre una sesion para un usuario y devuelve el token en claro.
 *
 * Es la unica vez que el token existe fuera del dispositivo del usuario: se
 * devuelve aca y no se vuelve a poder leer, porque la base solo guarda el hash.
 *
 * `tiendaId` es la tienda que el empleado eligio al entrar. Queda grabada en la
 * sesion y es la que define el alcance de todo lo que haga en ese turno. Para
 * el administrador es null: opera sobre las dos.
 *
 * POR QUE EL VENCIMIENTO SE CALCULA EN LA BASE Y NO EN JAVASCRIPT:
 * la tabla exige expira_en > created_at, y created_at lo pone la base con
 * SYSUTCDATETIME(). Calcular el vencimiento aca mezcla dos relojes -- el del
 * proceso y el del servidor -- y la restriccion se rompe si difieren. Con
 * DATEADD sobre SYSUTCDATETIME() los dos extremos salen del mismo reloj.
 */
export async function crearSesion(db, usuario, { dispositivoId = null, tiendaId = null } = {}) {
  // 32 bytes = 256 bits de entropia. Adivinarlo no es un escenario a considerar.
  const token = randomBytes(32).toString('base64url');
  const minutos = MINUTOS[usuario.rol] ?? MINUTOS.administrador;

  const { rows } = await db.query(
    `INSERT INTO SESION (token_hash, usuario_id, dispositivo_id, tienda_id, expira_en)
     OUTPUT INSERTED.expira_en
     VALUES (@token_hash, @usuario_id, @dispositivo_id, @tienda_id,
             DATEADD(MINUTE, @minutos, SYSUTCDATETIME()))`,
    {
      token_hash: hashToken(token),
      usuario_id: usuario.id,
      dispositivo_id: dispositivoId,
      tienda_id: tiendaId,
      minutos,
    },
  );

  return { token, expira_en: rows[0].expira_en.toISOString() };
}

/**
 * Busca la sesion de un token y devuelve el usuario, o null si no vale.
 *
 * Una sola consulta trae sesion y usuario juntos. Las condiciones de validez
 * van en el WHERE y no en el codigo a proposito: asi no existe el camino en el
 * que alguien agrega una comprobacion nueva y se olvida de alguna. O la fila
 * cumple todo, o no viene.
 *
 * tienda_id sale de la SESION, no del usuario: desde que un empleado puede
 * estar asignado a las dos tiendas, "de que tienda es" no es una propiedad de
 * la persona sino de su turno.
 */
export async function usuarioDeToken(db, token) {
  if (!token) return null;

  const { rows } = await db.query(
    `SELECT u.id, u.nombre, u.rol, u.negocio_id, u.email,
            s.tienda_id, s.expira_en, s.dispositivo_id
       FROM SESION  s
       JOIN Usuario u ON u.id = s.usuario_id
      WHERE s.token_hash  = @token_hash
        AND s.revocada_en IS NULL
        AND s.expira_en   > SYSUTCDATETIME()
        AND u.activo      = 1`,
    { token_hash: hashToken(token) },
  );

  return rows[0] ?? null;
}

/**
 * Cierra una sesion concreta (el boton de salir).
 *
 * Devuelve si habia algo que cerrar. El filtro por revocada_en IS NULL hace
 * que cerrar dos veces la misma sesion no vuelva a mover la fecha: la primera
 * vez es la que quedo registrada.
 */
export async function revocarSesion(db, token) {
  const { rowCount } = await db.query(
    `UPDATE SESION SET revocada_en = SYSUTCDATETIME()
      WHERE token_hash = @token_hash AND revocada_en IS NULL`,
    { token_hash: hashToken(token) },
  );
  return rowCount > 0;
}

/**
 * Cierra TODAS las sesiones de un usuario.
 *
 * Es lo que hay que correr cuando una tablet se pierde o alguien deja de
 * trabajar en el negocio. Tambien al cambiar el PIN o la contrasenia: si no,
 * quien hubiera entrado con la clave vieja sigue adentro.
 */
export async function revocarSesionesDe(db, usuarioId) {
  const { rowCount } = await db.query(
    `UPDATE SESION SET revocada_en = SYSUTCDATETIME()
      WHERE usuario_id = @usuario_id AND revocada_en IS NULL`,
    { usuario_id: usuarioId },
  );
  return rowCount;
}
