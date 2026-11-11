// =============================================================================
// Tablets (DISPOSITIVO)
//
// Cada tablet se da de alta sola la primera vez que alguien entra en ella, y
// manda su id en cada envio. Con eso el panel puede avisar "la tablet de la
// plastiqueria no envia hace 3 horas", que suele ser el primer sintoma de un
// problema (sin senial, apagada, o con ventas que no estan llegando).
//
// La baja es del administrador: es lo que se hace con una tablet perdida o
// robada. Una tablet dada de baja deja de aparecer en el panel y sus envios ya
// no la ponen "al dia" (las ventas que mande igual entran: son ventas reales).
// =============================================================================

import { EsquemaDispositivoNuevo, EsquemaDispositivoCambio, EsquemaIdEnUrl } from '../validacion.mjs';
import { exigirRol, puedeOperarEn, ADMIN } from '../auth/guardia.mjs';
import { leer, responderError } from './_ayudas.mjs';

/**
 * El dispositivo, si existe, esta activo y es de una tienda en la que el
 * usuario puede operar. Si no, null.
 *
 * Lo usan el ingreso y la sincronizacion: un id de otra tienda o de una tablet
 * dada de baja se IGNORA en lugar de rechazar el pedido. Rechazar el ingreso
 * o el envio por eso dejaria la tienda sin poder vender por un dato que no
 * cambia nada de lo que se vende.
 */
export async function dispositivoValido(db, usuario, dispositivoId, tiendaId = null) {
  if (dispositivoId == null) return null;
  const { rows } = await db.query(
    'SELECT id, tienda_id FROM DISPOSITIVO WHERE id = @id AND activo = 1',
    { id: Number(dispositivoId) },
  );
  const d = rows[0];
  if (!d) return null;
  if (tiendaId != null && d.tienda_id !== tiendaId) return null;
  // Sin usuario de sesion (el ingreso, donde todavia no la hay) alcanza con
  // la tienda: el ingreso ya comprobo que el empleado esta asignado a ella.
  if (usuario && !puedeOperarEn(usuario, d.tienda_id)) return null;
  return d;
}

export default async function rutasDispositivos(app, { db }) {
  // ---------------------------------------------------------------------------
  // POST /dispositivos -- alta de una tablet
  // ---------------------------------------------------------------------------
  app.post('/dispositivos', async (peticion, respuesta) => {
    const { datos, error } = leer(EsquemaDispositivoNuevo, peticion.body);
    if (error) return respuesta.code(400).send({ error: 'datos de la tablet invalidos', detalles: error });

    const u = peticion.usuario;
    // El empleado la da de alta en la tienda de su sesion; si manda otra, se
    // valida contra la sesion, no la reemplaza.
    const tiendaId = u.tienda_id ?? datos.tienda_id ?? null;
    if (tiendaId == null) {
      return respuesta.code(400).send({ error: 'indique de que tienda es la tablet' });
    }
    if (datos.tienda_id != null && datos.tienda_id !== tiendaId) {
      return respuesta.code(403).send({ error: 'no puede dar de alta una tablet en esa tienda' });
    }
    if (!puedeOperarEn(u, tiendaId)) {
      return respuesta.code(403).send({ error: 'no puede dar de alta una tablet en esa tienda' });
    }

    try {
      const { rows } = await db.query(
        `DECLARE @nuevo TABLE (id INT);
         INSERT INTO DISPOSITIVO (tienda_id, nombre)
         OUTPUT INSERTED.id INTO @nuevo
         VALUES (@tienda_id, @nombre);
         SELECT id FROM @nuevo;`,
        { tienda_id: tiendaId, nombre: datos.nombre },
      );
      return respuesta.code(201).send({ id: rows[0].id, nombre: datos.nombre, tienda_id: tiendaId });
    } catch (e) {
      return responderError(e, respuesta, peticion.log, 'fallo al dar de alta la tablet');
    }
  });

  // ---------------------------------------------------------------------------
  // PATCH /dispositivos/:id -- renombrar o dar de baja      [administrador]
  // ---------------------------------------------------------------------------
  app.patch('/dispositivos/:id', { preHandler: exigirRol(ADMIN) }, async (peticion, respuesta) => {
    const params = leer(EsquemaIdEnUrl, peticion.params);
    if (params.error) return respuesta.code(400).send({ error: 'identificador invalido' });
    const { datos, error } = leer(EsquemaDispositivoCambio, peticion.body);
    if (error) return respuesta.code(400).send({ error: 'cambio invalido', detalles: error });

    const { rowCount } = await db.query(
      `UPDATE DISPOSITIVO
          SET nombre = COALESCE(@nombre, nombre),
              activo = COALESCE(@activo, activo)
        WHERE id = @id`,
      { id: params.datos.id, nombre: datos.nombre ?? null,
        activo: datos.activo === undefined ? null : (datos.activo ? 1 : 0) },
    );
    if (!rowCount) return respuesta.code(404).send({ error: 'tablet no encontrada' });
    return { actualizado: true };
  });
}
