// =============================================================================
// Usuarios: alta, asignacion a tiendas y cambio de claves
//
// Todo lo que administra usuarios es del administrador, con UNA excepcion: cada
// persona puede cambiar SU propia clave. Esa excepcion no es una comodidad, es
// lo que hace que las claves sirvan: si solo la duenia pudiera cambiarlas,
// nadie cambiaria nunca la suya y el PIN que se le dijo en voz alta el primer
// dia seguiria siendo valido un anio despues.
//
// AL CAMBIAR UNA CLAVE SE CIERRAN TODAS LAS SESIONES.
// Si no, quien hubiera entrado con la clave vieja -- que es justamente el
// motivo por el que se la cambia -- seguiria adentro con su token intacto.
// =============================================================================

import {
  EsquemaUsuarioNuevo,
  EsquemaUsuarioCambio,
  EsquemaCambioPassword,
  EsquemaCambioPin,
  EsquemaReinicioPin,
  EsquemaIdEnUrl,
} from '../validacion.mjs';
import { exigirRol, ADMIN } from '../auth/guardia.mjs';
import { hashear, verificar } from '../auth/password.mjs';
import { revocarSesionesDe } from '../auth/sesiones.mjs';
import { leer, responderError } from './_ayudas.mjs';

export default async function rutasUsuarios(app, { db }) {
  // ---------------------------------------------------------------------------
  // POST /mi-clave                        [cualquiera con sesion]
  //
  // Cambio de la propia contrasenia (administrador).
  // ---------------------------------------------------------------------------
  app.post('/mi-clave', async (peticion, respuesta) => {
    const { datos, error } = leer(EsquemaCambioPassword, peticion.body);
    if (error) return respuesta.code(400).send({ error: 'datos invalidos', detalles: error });

    const { rows } = await db.query(
      'SELECT password_hash FROM Usuario WHERE id = @id',
      { id: peticion.usuario.id },
    );
    if (!rows[0]?.password_hash) {
      return respuesta.code(409).send({ error: 'su cuenta no usa contrasenia, usa PIN' });
    }

    // Se exige la clave ACTUAL aunque la sesion ya este autenticada: el token
    // pudo quedar abierto en una computadora compartida, y sin esto cualquiera
    // que la encuentre desbloqueada se queda con la cuenta.
    if (!await verificar(datos.actual, rows[0].password_hash)) {
      return respuesta.code(401).send({ error: 'la contrasenia actual no es correcta' });
    }

    await db.query(
      'UPDATE Usuario SET password_hash = @hash WHERE id = @id',
      { hash: await hashear(datos.nueva), id: peticion.usuario.id },
    );
    const cerradas = await revocarSesionesDe(db, peticion.usuario.id);

    // Incluida la sesion que hizo el cambio: hay que volver a entrar. Es
    // deliberado, y la respuesta lo dice para que el cliente no lo descubra
    // con un 401 inesperado.
    return { cambiada: true, sesiones_cerradas: cerradas, debe_volver_a_entrar: true };
  });

  // ---------------------------------------------------------------------------
  // POST /mi-pin                          [cualquiera con sesion]
  // ---------------------------------------------------------------------------
  app.post('/mi-pin', async (peticion, respuesta) => {
    const { datos, error } = leer(EsquemaCambioPin, peticion.body);
    if (error) return respuesta.code(400).send({ error: 'datos invalidos', detalles: error });

    const { rows } = await db.query(
      'SELECT pin_hash FROM Usuario WHERE id = @id',
      { id: peticion.usuario.id },
    );
    if (!rows[0]?.pin_hash) {
      return respuesta.code(409).send({ error: 'su cuenta no usa PIN' });
    }
    if (!await verificar(datos.actual, rows[0].pin_hash)) {
      return respuesta.code(401).send({ error: 'el PIN actual no es correcto' });
    }

    await db.query(
      'UPDATE Usuario SET pin_hash = @hash WHERE id = @id',
      { hash: await hashear(datos.nuevo), id: peticion.usuario.id },
    );
    const cerradas = await revocarSesionesDe(db, peticion.usuario.id);

    return { cambiado: true, sesiones_cerradas: cerradas, debe_volver_a_entrar: true };
  });

  // ---------------------------------------------------------------------------
  // Desde aca, todo es del administrador.
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // GET /usuarios                         [administrador]
  // ---------------------------------------------------------------------------
  app.get('/usuarios', { preHandler: exigirRol(ADMIN) }, async (peticion) => {
    const { rows } = await db.query(
      `SELECT u.id, u.nombre, u.rol, u.email, u.activo, u.ultimo_acceso,
              u.created_at,
              CAST(CASE WHEN u.pin_hash      IS NULL THEN 0 ELSE 1 END AS BIT) AS tiene_pin,
              CAST(CASE WHEN u.password_hash IS NULL THEN 0 ELSE 1 END AS BIT) AS tiene_clave,
              (SELECT STRING_AGG(t.nombre, ', ')
                 FROM USUARIO_TIENDA ut
                 JOIN TIENDA t ON t.id = ut.tienda_id
                WHERE ut.usuario_id = u.id) AS tiendas,
              (SELECT COUNT(*) FROM SESION s
                WHERE s.usuario_id = u.id
                  AND s.revocada_en IS NULL
                  AND s.expira_en > SYSUTCDATETIME()) AS sesiones_activas
         FROM Usuario u
        WHERE u.negocio_id = @negocio
        ORDER BY u.rol, u.nombre`,
      { negocio: peticion.usuario.negocio_id },
    );
    // Nunca se devuelven los hashes: solo si existen, que es lo que la pantalla
    // necesita para saber si a alguien le falta configurar su acceso.
    return { usuarios: rows };
  });

  // ---------------------------------------------------------------------------
  // POST /usuarios                        [administrador]
  //
  // Las credenciales llegan en claro por HTTPS y se hashean ACA: nunca se
  // guardan como vinieron, y no se devuelven en la respuesta ni al
  // administrador que acaba de crearlas. Si se pierden, se reinician.
  // ---------------------------------------------------------------------------
  app.post('/usuarios', { preHandler: exigirRol(ADMIN) }, async (peticion, respuesta) => {
    const { datos, error } = leer(EsquemaUsuarioNuevo, peticion.body);
    if (error) return respuesta.code(400).send({ error: 'datos de usuario invalidos', detalles: error });

    try {
      const creado = await db.tx(async (tx) => {
        const { rows } = await tx.query(
          `DECLARE @nuevo TABLE (id INT);
           INSERT INTO Usuario (negocio_id, nombre, rol, email, password_hash, pin_hash)
           OUTPUT INSERTED.id INTO @nuevo
           VALUES (@negocio_id, @nombre, @rol, @email, @password_hash, @pin_hash);
           SELECT id FROM @nuevo;`,
          {
            negocio_id: peticion.usuario.negocio_id,
            nombre: datos.nombre,
            rol: datos.rol,
            email: datos.email ? datos.email.toLowerCase() : null,
            password_hash: datos.password ? await hashear(datos.password) : null,
            pin_hash: datos.pin ? await hashear(datos.pin) : null,
          },
        );
        const id = rows[0].id;

        // Las asignaciones van en la MISMA transaccion que el usuario: un
        // empleado sin tienda no puede entrar a ninguna parte, asi que si esto
        // fallara despues quedaria una cuenta inservible que nada denuncia.
        for (const tiendaId of datos.tiendas) {
          await tx.query(
            'INSERT INTO USUARIO_TIENDA (usuario_id, tienda_id) VALUES (@u, @t)',
            { u: id, t: tiendaId },
          );
        }

        return id;
      });

      return respuesta.code(201).send({
        id: creado, nombre: datos.nombre, rol: datos.rol, tiendas: datos.tiendas,
      });
    } catch (e) {
      return responderError(e, respuesta, peticion.log, 'fallo al crear el usuario');
    }
  });

  // ---------------------------------------------------------------------------
  // PATCH /usuarios/:id                   [administrador]
  //
  // No toca credenciales: para eso estan /mi-pin, /mi-clave y el reinicio.
  // Mezclarlas aca haria que un cambio de nombre y un cambio de clave pasaran
  // por el mismo camino, y solo uno de los dos tiene que cerrar las sesiones.
  // ---------------------------------------------------------------------------
  app.patch('/usuarios/:id', { preHandler: exigirRol(ADMIN) }, async (peticion, respuesta) => {
    const params = leer(EsquemaIdEnUrl, peticion.params);
    if (params.error) return respuesta.code(400).send({ error: 'identificador invalido' });

    const { datos, error } = leer(EsquemaUsuarioCambio, peticion.body);
    if (error) return respuesta.code(400).send({ error: 'datos de usuario invalidos', detalles: error });

    const id = params.datos.id;

    // Darse de baja a si mismo dejaria el negocio sin administrador y sin forma
    // de volver a entrar a arreglarlo.
    if (datos.activo === false && id === peticion.usuario.id) {
      return respuesta.code(409).send({ error: 'no puede darse de baja a si mismo' });
    }

    try {
      await db.tx(async (tx) => {
        const partes = [];
        const valores = { id, negocio: peticion.usuario.negocio_id };
        for (const campo of ['nombre', 'email', 'activo']) {
          if (campo in datos) {
            partes.push(`${campo} = @${campo}`);
            valores[campo] = campo === 'activo'
              ? (datos[campo] ? 1 : 0)
              : (campo === 'email' ? (datos[campo]?.toLowerCase() ?? null) : datos[campo] ?? null);
          }
        }

        if (partes.length > 0) {
          const { rowCount } = await tx.query(
            `UPDATE Usuario SET ${partes.join(', ')}
              WHERE id = @id AND negocio_id = @negocio`,
            valores,
          );
          if (rowCount === 0) throw Object.assign(new Error('no existe'), { noExiste: true });
        }

        // Las tiendas se reemplazan enteras, no se agregan: la pantalla manda
        // la lista completa de casillas marcadas, y un alta incremental no
        // podria expresar "ya no trabaja en la plastiqueria".
        if (datos.tiendas) {
          await tx.query('DELETE FROM USUARIO_TIENDA WHERE usuario_id = @id', { id });
          for (const tiendaId of datos.tiendas) {
            await tx.query(
              'INSERT INTO USUARIO_TIENDA (usuario_id, tienda_id) VALUES (@u, @t)',
              { u: id, t: tiendaId },
            );
          }
        }
      });

      // Quitarle una tienda o darlo de baja no debe dejarlo adentro con la
      // sesion que ya tenia abierta en esa tienda.
      let cerradas = 0;
      if (datos.activo === false || datos.tiendas) {
        cerradas = await revocarSesionesDe(db, id);
      }

      return { actualizado: true, campos: Object.keys(datos), sesiones_cerradas: cerradas };
    } catch (e) {
      if (e.noExiste) return respuesta.code(404).send({ error: 'usuario no encontrado' });
      return responderError(e, respuesta, peticion.log, 'fallo al modificar el usuario');
    }
  });

  // ---------------------------------------------------------------------------
  // POST /usuarios/:id/pin                [administrador]
  //
  // Reinicio del PIN de un empleado. No se le pide el actual porque el caso de
  // uso es justamente que lo olvido.
  // ---------------------------------------------------------------------------
  app.post('/usuarios/:id/pin', { preHandler: exigirRol(ADMIN) }, async (peticion, respuesta) => {
    const params = leer(EsquemaIdEnUrl, peticion.params);
    if (params.error) return respuesta.code(400).send({ error: 'identificador invalido' });

    const { datos, error } = leer(EsquemaReinicioPin, peticion.body);
    if (error) return respuesta.code(400).send({ error: 'PIN invalido', detalles: error });

    try {
      const { rowCount } = await db.query(
        `UPDATE Usuario SET pin_hash = @hash
          WHERE id = @id AND negocio_id = @negocio AND rol = 'empleado'`,
        {
          hash: await hashear(datos.pin),
          id: params.datos.id,
          negocio: peticion.usuario.negocio_id,
        },
      );
      if (rowCount === 0) {
        return respuesta.code(404).send({ error: 'empleado no encontrado' });
      }

      const cerradas = await revocarSesionesDe(db, params.datos.id);

      // Tambien se limpian los intentos fallidos: si el empleado quedo
      // bloqueado por teclear mal el PIN que no recordaba, reiniciarlo sin
      // limpiar la ventana lo dejaria sin poder entrar con el PIN nuevo.
      await db.query(
        'DELETE FROM INTENTO_LOGIN WHERE identificador = @id AND exitoso = 0',
        { id: String(params.datos.id) },
      );

      return { reiniciado: true, sesiones_cerradas: cerradas };
    } catch (e) {
      return responderError(e, respuesta, peticion.log, 'fallo al reiniciar el PIN');
    }
  });
}
