// =============================================================================
// Sesiones: crear, verificar y revocar
//
// El token que recibe el cliente son 32 bytes al azar en base64url. No lleva
// informacion adentro: es una llave opaca que solo sirve para encontrar la fila
// correspondiente en la tabla sesiones.
//
// En la base NO se guarda el token sino su SHA-256. El razonamiento completo
// esta en el comentario de la tabla, en db/schema.sql (3.12).
// =============================================================================

import { randomBytes, createHash } from 'node:crypto';

// Cuanto dura una sesion segun quien entra.
//
// El empleado trabaja todo el dia en la misma tablet, muchas veces sin senial:
// pedirle el PIN cada hora seria inusable, y si la sesion caduca estando sin
// conexion no puede renovarla. Doce horas cubre un turno completo.
//
// El admin entra desde el navegador a mirar numeros, posiblemente desde una
// computadora compartida. Dos horas.
const DURACION = {
  empleado:  12 * 60 * 60 * 1000,
  encargado: 12 * 60 * 60 * 1000,
  admin:      2 * 60 * 60 * 1000,
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
 */
export async function crearSesion(db, usuario, dispositivoId = null) {
  // 32 bytes = 256 bits de entropia. Adivinarlo no es un escenario a considerar.
  const token = randomBytes(32).toString('base64url');
  const expiraEn = new Date(Date.now() + (DURACION[usuario.rol] ?? DURACION.admin));

  await db.query(
    `INSERT INTO sesiones (token_hash, usuario_id, dispositivo_id, expira_en)
     VALUES ($1, $2, $3, $4)`,
    [hashToken(token), usuario.id, dispositivoId, expiraEn],
  );

  return { token, expira_en: expiraEn.toISOString() };
}

/**
 * Busca la sesion de un token y devuelve el usuario, o null si no vale.
 *
 * Una sola consulta trae sesion y usuario juntos. Las condiciones de validez
 * van en el WHERE y no en el codigo a proposito: asi no existe el camino en el
 * que alguien agrega una comprobacion nueva y se olvida de alguna. O la fila
 * cumple todo, o no viene.
 */
export async function usuarioDeToken(db, token) {
  if (!token) return null;

  const { rows } = await db.query(
    `SELECT u.id, u.nombre, u.rol, u.tienda_id, u.negocio_id, u.email,
            s.token_hash, s.expira_en, s.dispositivo_id
       FROM sesiones s
       JOIN usuarios u ON u.id = s.usuario_id
      WHERE s.token_hash  = $1
        AND s.revocada_en IS NULL
        AND s.expira_en   > NOW()
        AND u.activo`,
    [hashToken(token)],
  );

  return rows[0] ?? null;
}

/** Cierra una sesion concreta (el boton de salir). */
export async function revocarSesion(db, token) {
  const { rows } = await db.query(
    `UPDATE sesiones SET revocada_en = NOW()
      WHERE token_hash = $1 AND revocada_en IS NULL
      RETURNING token_hash`,
    [hashToken(token)],
  );
  return rows.length > 0;
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
    `UPDATE sesiones SET revocada_en = NOW()
      WHERE usuario_id = $1 AND revocada_en IS NULL`,
    [usuarioId],
  );
  return rowCount;
}
