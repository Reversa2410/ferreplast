// =============================================================================
// Limite de intentos de ingreso
//
// El hash protege la base si se la roban. No protege de que alguien pruebe PIN
// por la puerta de entrada, que con 4 digitos son 10.000 combinaciones.
// Esto es lo que cierra esa puerta.
//
// ESTRATEGIA: ventana deslizante. Se cuentan los fallos de los ultimos N
// minutos; pasado el umbral se rechaza aunque la clave sea correcta.
//
// POR QUE NO SE BLOQUEA LA CUENTA HASTA QUE UN ADMIN LA DESBLOQUEE:
// Porque seria un modo trivial de dejar sin trabajar al mostrador: basta que
// alguien teclee cinco PIN malos para que el empleado no pueda vender, y en
// una tienda sin internet no hay admin a mano que lo arregle. La ventana se
// vacia sola: el bloqueo dura minutos, no hasta que alguien intervenga.
// =============================================================================

const UMBRAL = 5;             // fallos permitidos dentro de la ventana
const VENTANA_MINUTOS = 15;

// La columna identificador es VARCHAR(150). El valor es el email del
// administrador o el id del empleado, asi que se normaliza a texto en un solo
// lugar: si un lado guardara 7 y el otro buscara "7", la ventana no contaria
// nada y el limite no existiria, sin que nada falle.
const comoIdentificador = (valor) => String(valor).slice(0, 150);

/**
 * Deja constancia de un intento, haya salido bien o mal.
 *
 * Nunca lanza: si la bitacora falla, el usuario igual tiene que poder entrar.
 * Un problema al registrar la auditoria no puede dejar a la tienda sin vender.
 */
export async function registrarIntento(db, { identificador, tiendaId = null, exitoso, ip = null }, log) {
  try {
    await db.query(
      `INSERT INTO INTENTO_LOGIN (identificador, tienda_id, exitoso, ip)
       VALUES (@identificador, @tienda_id, @exitoso, @ip)`,
      {
        identificador: comoIdentificador(identificador),
        tienda_id: tiendaId,
        exitoso: exitoso ? 1 : 0,
        ip,
      },
    );
  } catch (e) {
    log?.warn({ err: e }, 'no se pudo registrar el intento de ingreso');
  }
}

/**
 * Dice si este identificador esta bloqueado ahora mismo.
 *
 * El conteo se hace en la base y no en memoria del proceso a proposito: si la
 * API corriera en dos instancias, un contador en memoria permitiria el doble de
 * intentos (la mitad a cada una) sin que nadie lo note.
 */
export async function estaBloqueado(db, identificador) {
  const { rows } = await db.query(
    `SELECT COUNT(*) AS fallos
       FROM INTENTO_LOGIN
      WHERE identificador = @identificador
        AND exitoso       = 0
        AND created_at    > DATEADD(MINUTE, -@ventana, SYSUTCDATETIME())`,
    { identificador: comoIdentificador(identificador), ventana: VENTANA_MINUTOS },
  );

  const fallos = rows[0]?.fallos ?? 0;
  return { bloqueado: fallos >= UMBRAL, fallos, umbral: UMBRAL, ventana_minutos: VENTANA_MINUTOS };
}

/**
 * Borra los fallos acumulados de un identificador.
 *
 * Se llama tras un ingreso correcto: quien demostro saber la clave no deberia
 * arrastrar los tropiezos previos (el empleado que se equivoco tres veces de
 * PIN antes de acertar empieza de cero).
 *
 * Solo borra los FALLOS. Los aciertos quedan: son la auditoria de quien entro.
 */
export async function limpiarFallos(db, identificador, log) {
  try {
    await db.query(
      `DELETE FROM INTENTO_LOGIN
        WHERE identificador = @identificador AND exitoso = 0`,
      { identificador: comoIdentificador(identificador) },
    );
  } catch (e) {
    log?.warn({ err: e }, 'no se pudieron limpiar los intentos fallidos');
  }
}
