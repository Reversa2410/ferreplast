// =============================================================================
// Apertura y cierre de caja
//
// El turno de un empleado empieza abriendo la caja con el efectivo que hay en
// el cajon y termina contandolo. La diferencia entre lo contado y lo esperado
// es el numero que la duenia mira: es lo que hoy no existe y es la razon por la
// que no puede saber si falta plata.
//
// LA DIFERENCIA LA CALCULA EL SERVIDOR, NO EL EMPLEADO.
// Al cerrar solo se pide `efectivo_contado`: cuanto habia en el cajon. Lo
// esperado sale de las ventas en efectivo mas los abonos de credito en
// efectivo, y la diferencia es la resta. Si el empleado escribiera la
// diferencia, el numero que delata un faltante lo pondria quien lo tendria.
//
// `CAJA.diferencia` se guarda igual, en lugar de calcularse siempre desde la
// vista: es una FOTO del momento del cierre. Una venta que se anule manana
// cambia lo esperado de hoy, y lo que hay que poder reconstruir es que se
// conto esa tarde, no que se contaria ahora. `v_cuadre_caja.cuadra` compara
// las dos cosas y avisa cuando dejaron de coincidir.
// =============================================================================

import {
  EsquemaAperturaCaja,
  EsquemaCierreCaja,
  EsquemaIdEnUrl,
} from '../validacion.mjs';
import { puedeOperarEn, ADMIN } from '../auth/guardia.mjs';
import { leer, responderError, tiendaDeLaPeticion } from './_ayudas.mjs';

export default async function rutasCaja(app, { db }) {
  // ---------------------------------------------------------------------------
  // GET /caja/actual
  //
  // La caja abierta de la tienda, con el cuadre al dia. Es lo que la pantalla
  // de venta necesita saber antes de cobrar en efectivo.
  // ---------------------------------------------------------------------------
  app.get('/caja/actual', async (peticion, respuesta) => {
    const tiendaId = tiendaDeLaPeticion(peticion.usuario, peticion.query.tienda_id);
    if (tiendaId == null) {
      return respuesta.code(400).send({ error: 'indique la tienda' });
    }
    if (!puedeOperarEn(peticion.usuario, tiendaId)) {
      return respuesta.code(403).send({ error: 'no tiene acceso a esa tienda' });
    }

    const { rows } = await db.query(
      `SELECT caja_id, tienda_id, tienda, usuario, estado, abierta_en,
              monto_inicial, vendido_efectivo, abonado_efectivo, esperado
         FROM v_cuadre_caja
        WHERE tienda_id = @t AND estado = 'abierta'`,
      { t: tiendaId },
    );

    if (rows.length === 0) {
      // 200 y no 404: "no hay caja abierta" es una respuesta valida y esperable
      // al empezar el dia, no un error. Con 404 la pantalla tendria que tratar
      // el caso normal como una falla.
      return { abierta: false, tienda_id: tiendaId };
    }

    return { abierta: true, caja: rows[0] };
  });

  // ---------------------------------------------------------------------------
  // POST /caja/apertura
  // ---------------------------------------------------------------------------
  app.post('/caja/apertura', async (peticion, respuesta) => {
    const { datos, error } = leer(EsquemaAperturaCaja, peticion.body);
    if (error) return respuesta.code(400).send({ error: 'datos de apertura invalidos', detalles: error });

    if (!puedeOperarEn(peticion.usuario, datos.tienda_id)) {
      return respuesta.code(403).send({ error: 'no puede abrir caja en esa tienda' });
    }

    try {
      const { rows } = await db.query(
        `DECLARE @nueva TABLE (id INT);
         INSERT INTO CAJA (tienda_id, usuario_id, monto_inicial, estado, observaciones)
         OUTPUT INSERTED.id INTO @nueva
         VALUES (@tienda_id, @usuario_id, @monto_inicial, 'abierta', @observaciones);
         SELECT id FROM @nueva;`,
        {
          tienda_id: datos.tienda_id,
          usuario_id: peticion.usuario.id,
          monto_inicial: datos.monto_inicial,
          observaciones: datos.observaciones ?? null,
        },
      );
      return respuesta.code(201).send({
        caja_id: rows[0].id,
        monto_inicial: datos.monto_inicial,
      });
    } catch (e) {
      // UX_CAJA_ABIERTA_POR_TIENDA es un indice unico filtrado sobre
      // estado = 'abierta': intentar abrir una segunda caja en la misma tienda
      // choca contra el y llega aca como duplicado. El mensaje generico de
      // responderError no explicaria nada, asi que este caso se nombra.
      const numero = e?.number ?? e?.originalError?.info?.number;
      if (numero === 2601 || numero === 2627) {
        return respuesta.code(409).send({
          error: 'ya hay una caja abierta en esta tienda; hay que cerrarla primero',
        });
      }
      return responderError(e, respuesta, peticion.log, 'fallo al abrir la caja');
    }
  });

  // ---------------------------------------------------------------------------
  // POST /caja/:id/cierre
  // ---------------------------------------------------------------------------
  app.post('/caja/:id/cierre', async (peticion, respuesta) => {
    const params = leer(EsquemaIdEnUrl, peticion.params);
    if (params.error) return respuesta.code(400).send({ error: 'identificador invalido' });

    const { datos, error } = leer(EsquemaCierreCaja, peticion.body);
    if (error) return respuesta.code(400).send({ error: 'datos de cierre invalidos', detalles: error });

    // Lo esperado se lee de la vista, que es la que sabe sumar las ventas en
    // efectivo y los abonos. Replicar ese calculo aca seria tener dos
    // definiciones de "esperado" que algun dia dejarian de coincidir.
    const { rows } = await db.query(
      `SELECT caja_id, tienda_id, estado, usuario, monto_inicial,
              vendido_efectivo, abonado_efectivo, esperado
         FROM v_cuadre_caja
        WHERE caja_id = @id`,
      { id: params.datos.id },
    );
    const caja = rows[0];
    if (!caja) return respuesta.code(404).send({ error: 'caja no encontrada' });

    if (!puedeOperarEn(peticion.usuario, caja.tienda_id)) {
      return respuesta.code(403).send({ error: 'no puede cerrar la caja de esa tienda' });
    }
    if (caja.estado !== 'abierta') {
      return respuesta.code(409).send({ error: 'esa caja ya estaba cerrada' });
    }

    // Quien cierra tiene que ser quien abrio, o el administrador. Un empleado
    // no cierra el turno de otro: la diferencia quedaria a nombre equivocado.
    const { rows: dueno } = await db.query(
      'SELECT usuario_id FROM CAJA WHERE id = @id', { id: params.datos.id },
    );
    if (peticion.usuario.rol !== ADMIN && dueno[0].usuario_id !== peticion.usuario.id) {
      return respuesta.code(403).send({ error: 'esa caja la abrio otra persona' });
    }

    const esperado = Number(caja.esperado);
    const diferencia = Math.round((datos.efectivo_contado - esperado) * 100) / 100;

    try {
      await db.query(
        `UPDATE CAJA
            SET efectivo_contado = CAST(@contado AS DECIMAL(18,2)),
                diferencia       = CAST(@diferencia AS DECIMAL(18,2)),
                estado           = 'cerrada',
                cerrada_en       = SYSUTCDATETIME(),
                observaciones    = ISNULL(observaciones + ' | ', '') + ISNULL(@observaciones, '')
          WHERE id = @id AND estado = 'abierta'`,
        {
          id: params.datos.id,
          contado: datos.efectivo_contado,
          diferencia,
          observaciones: datos.observaciones ?? null,
        },
      );

      return {
        cerrada: true,
        caja_id: params.datos.id,
        monto_inicial: Number(caja.monto_inicial),
        vendido_efectivo: Number(caja.vendido_efectivo),
        abonado_efectivo: Number(caja.abonado_efectivo),
        esperado,
        efectivo_contado: datos.efectivo_contado,
        diferencia,
        // El signo es lo que la duenia lee de un vistazo: negativo es faltante.
        resultado: diferencia === 0 ? 'cuadra' : (diferencia > 0 ? 'sobrante' : 'faltante'),
      };
    } catch (e) {
      return responderError(e, respuesta, peticion.log, 'fallo al cerrar la caja');
    }
  });

  // ---------------------------------------------------------------------------
  // GET /caja/:id
  //
  // El detalle de un turno: el cuadre y las ventas que lo componen. Es a donde
  // se entra cuando el cierre no cuadro y hay que mirar por que.
  // ---------------------------------------------------------------------------
  app.get('/caja/:id', async (peticion, respuesta) => {
    const params = leer(EsquemaIdEnUrl, peticion.params);
    if (params.error) return respuesta.code(400).send({ error: 'identificador invalido' });

    const { rows } = await db.query(
      'SELECT * FROM v_cuadre_caja WHERE caja_id = @id', { id: params.datos.id },
    );
    const caja = rows[0];
    if (!caja) return respuesta.code(404).send({ error: 'caja no encontrada' });

    if (!puedeOperarEn(peticion.usuario, caja.tienda_id)) {
      return respuesta.code(404).send({ error: 'caja no encontrada' });
    }

    const { rows: ventas } = await db.query(
      `SELECT id, numero, total, metodo_pago, anulada, ocurrido_en
         FROM VENTA WHERE caja_id = @id ORDER BY ocurrido_en`,
      { id: params.datos.id },
    );
    const { rows: abonos } = await db.query(
      `SELECT p.id, p.monto, p.metodo_pago, p.ocurrido_en, c.nombre AS cliente
         FROM PAGO_CREDITO p
         JOIN CLIENTE c ON c.id = p.cliente_id
        WHERE p.caja_id = @id ORDER BY p.ocurrido_en`,
      { id: params.datos.id },
    );

    return { caja, ventas, abonos };
  });
}
