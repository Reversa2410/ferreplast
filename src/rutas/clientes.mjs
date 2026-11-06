// =============================================================================
// Clientes a credito y abonos
//
// Esta es la parte del negocio que hoy vive en la memoria de la duenia y en un
// cuaderno. El modelo la soporta desde la sesion en que se acordo el credito;
// esto es la puerta para usarla.
//
// QUIEN PUEDE QUE, Y POR QUE:
//   * Leer clientes y saldos: cualquiera con sesion. El empleado necesita ver
//     el cupo disponible ANTES de fiar, o la venta se va a rechazar despues de
//     haber entregado la mercaderia.
//   * Crear un cliente: el empleado tambien. Anotar el nombre y el telefono de
//     quien compra es trabajo de mostrador, y nace con el limite por omision
//     de la tabla (1000 cordobas).
//   * Cambiar el LIMITE: solo el administrador. Es la unica decision de esta
//     tabla que es plata: cuanto se le presta a alguien no lo decide quien esta
//     atendiendo.
//   * Registrar un abono: el empleado, en su tienda. Es quien recibe el
//     billete.
// =============================================================================

import {
  EsquemaClienteNuevo,
  EsquemaClienteCambio,
  EsquemaAbono,
  EsquemaIdEnUrl,
} from '../validacion.mjs';
import { exigirRol, ADMIN } from '../auth/guardia.mjs';
import { leer, responderError } from './_ayudas.mjs';

export default async function rutasClientes(app, { db }) {
  // ---------------------------------------------------------------------------
  // GET /clientes
  //
  // Trae el saldo junto con cada cliente, no solo los datos de contacto: la
  // pregunta del mostrador nunca es "quien es Pedro" sino "cuanto debe Pedro".
  // ---------------------------------------------------------------------------
  app.get('/clientes', async (peticion) => {
    const { q = null, con_deuda = null } = peticion.query;

    const { rows } = await db.query(
      `SELECT c.id, c.nombre, c.telefono, c.identificacion, c.limite_credito,
              c.activo,
              ISNULL(v.saldo, 0)           AS saldo,
              ISNULL(v.cupo_disponible, c.limite_credito) AS cupo_disponible,
              v.ultima_venta, v.ultimo_abono
         FROM CLIENTE c
         LEFT JOIN v_cuentas_por_cobrar v ON v.cliente_id = c.id
        WHERE c.activo = 1
          AND (@q IS NULL
               OR c.nombre   LIKE '%' + @q + '%'
               OR c.telefono LIKE '%' + @q + '%')
          AND (@con_deuda = 0 OR ISNULL(v.saldo, 0) > 0)
        ORDER BY c.nombre`,
      { q: q || null, con_deuda: con_deuda === '1' ? 1 : 0 },
    );

    return { clientes: rows };
  });

  // ---------------------------------------------------------------------------
  // POST /clientes
  // ---------------------------------------------------------------------------
  app.post('/clientes', async (peticion, respuesta) => {
    const { datos, error } = leer(EsquemaClienteNuevo, peticion.body);
    if (error) return respuesta.code(400).send({ error: 'datos de cliente invalidos', detalles: error });

    // El negocio sale de la sesion, no del cuerpo: el usuario pertenece a uno y
    // no tiene por que poder crear clientes en otro.
    try {
      const { rows } = await db.query(
        `DECLARE @nuevo TABLE (id INT, limite DECIMAL(18,2));
         INSERT INTO CLIENTE (negocio_id, nombre, telefono, identificacion)
         OUTPUT INSERTED.id, INSERTED.limite_credito INTO @nuevo
         VALUES (@negocio_id, @nombre, @telefono, @identificacion);
         SELECT id, limite AS limite_credito FROM @nuevo;`,
        {
          negocio_id: peticion.usuario.negocio_id,
          nombre: datos.nombre,
          telefono: datos.telefono ?? null,
          identificacion: datos.identificacion ?? null,
        },
      );
      return respuesta.code(201).send({
        id: rows[0].id,
        nombre: datos.nombre,
        limite_credito: Number(rows[0].limite_credito),
      });
    } catch (e) {
      return responderError(e, respuesta, peticion.log, 'fallo al crear el cliente');
    }
  });

  // ---------------------------------------------------------------------------
  // GET /clientes/:id/estado-cuenta
  //
  // Lo que hay que poder mostrarle a un cliente que pregunta cuanto debe: el
  // saldo, lo que se le fio y lo que fue pagando.
  // ---------------------------------------------------------------------------
  app.get('/clientes/:id/estado-cuenta', async (peticion, respuesta) => {
    const params = leer(EsquemaIdEnUrl, peticion.params);
    if (params.error) return respuesta.code(400).send({ error: 'identificador invalido' });
    const id = params.datos.id;

    const { rows } = await db.query(
      `SELECT cliente_id, nombre, telefono, limite_credito, total_fiado,
              total_abonado, saldo, cupo_disponible, ventas_a_credito,
              ultima_venta, ultimo_abono
         FROM v_cuentas_por_cobrar
        WHERE cliente_id = @id`,
      { id },
    );
    if (rows.length === 0) {
      return respuesta.code(404).send({ error: 'cliente no encontrado o dado de baja' });
    }

    const { rows: fiado } = await db.query(
      `SELECT v.id, v.numero, v.total, v.ocurrido_en, v.anulada,
              t.nombre AS tienda
         FROM VENTA v
         JOIN TIENDA t ON t.id = v.tienda_id
        WHERE v.cliente_id = @id AND v.metodo_pago = 'credito'
        ORDER BY v.ocurrido_en DESC`,
      { id },
    );

    const { rows: abonos } = await db.query(
      `SELECT p.id, p.monto, p.metodo_pago, p.observaciones, p.ocurrido_en,
              u.nombre AS recibido_por
         FROM PAGO_CREDITO p
         LEFT JOIN Usuario u ON u.id = p.usuario_id
        WHERE p.cliente_id = @id
        ORDER BY p.ocurrido_en DESC`,
      { id },
    );

    return { cliente: rows[0], ventas_fiadas: fiado, abonos };
  });

  // ---------------------------------------------------------------------------
  // POST /clientes/:id/abonos
  //
  // Un abono es un pago PARCIAL: el cliente paga lo que puede cuando puede.
  // No se valida contra el saldo a proposito -- pagar de mas es un caso real
  // (un adelanto, un redondeo) y el saldo simplemente queda negativo, que
  // significa saldo a favor. Rechazarlo obligaria al empleado a discutir con
  // el cliente por diez cordobas.
  // ---------------------------------------------------------------------------
  app.post('/clientes/:id/abonos', async (peticion, respuesta) => {
    const params = leer(EsquemaIdEnUrl, peticion.params);
    if (params.error) return respuesta.code(400).send({ error: 'identificador invalido' });

    const { datos, error } = leer(EsquemaAbono, peticion.body);
    if (error) return respuesta.code(400).send({ error: 'datos de abono invalidos', detalles: error });

    const { rows: existe } = await db.query(
      'SELECT id FROM CLIENTE WHERE id = @id AND negocio_id = @negocio AND activo = 1',
      { id: params.datos.id, negocio: peticion.usuario.negocio_id },
    );
    if (existe.length === 0) {
      return respuesta.code(404).send({ error: 'cliente no encontrado' });
    }

    // La caja se resuelve sola si no vino, igual que en las ventas: un abono en
    // efectivo que no entre en ninguna caja hace que el cuadre del turno de
    // sobrante sin explicacion.
    let cajaId = datos.caja_id ?? null;
    if (cajaId == null && peticion.usuario.tienda_id != null) {
      const { rows } = await db.query(
        "SELECT id FROM CAJA WHERE tienda_id = @t AND estado = 'abierta'",
        { t: peticion.usuario.tienda_id },
      );
      cajaId = rows[0]?.id ?? null;
    }
    if (cajaId == null && datos.metodo_pago === 'efectivo') {
      return respuesta.code(409).send({
        error: 'no hay una caja abierta; un abono en efectivo tiene que entrar en una caja',
      });
    }

    try {
      const { rows } = await db.query(
        `DECLARE @nuevo TABLE (id INT);
         INSERT INTO PAGO_CREDITO
             (cliente_id, caja_id, usuario_id, monto, metodo_pago, observaciones)
         OUTPUT INSERTED.id INTO @nuevo
         VALUES (@cliente_id, @caja_id, @usuario_id,
                 CAST(@monto AS DECIMAL(18,2)), @metodo_pago, @observaciones);
         SELECT id FROM @nuevo;`,
        {
          cliente_id: params.datos.id,
          caja_id: cajaId,
          usuario_id: peticion.usuario.id,
          monto: datos.monto,
          metodo_pago: datos.metodo_pago,
          observaciones: datos.observaciones ?? null,
        },
      );

      // Se devuelve el saldo que quedo: es lo que el empleado le dice al
      // cliente antes de que se vaya, y obliga a que salga de la base en lugar
      // de restarlo en la pantalla.
      const { rows: saldo } = await db.query(
        'SELECT saldo, cupo_disponible FROM v_cuentas_por_cobrar WHERE cliente_id = @id',
        { id: params.datos.id },
      );

      return respuesta.code(201).send({
        id: rows[0].id,
        monto: datos.monto,
        caja_id: cajaId,
        saldo_restante: Number(saldo[0]?.saldo ?? 0),
        cupo_disponible: Number(saldo[0]?.cupo_disponible ?? 0),
      });
    } catch (e) {
      return responderError(e, respuesta, peticion.log, 'fallo al registrar el abono');
    }
  });

  // ---------------------------------------------------------------------------
  // PATCH /clientes/:id                   [administrador]
  //
  // Incluye el limite de credito, que es la razon por la que esta ruta es solo
  // del administrador.
  // ---------------------------------------------------------------------------
  app.patch('/clientes/:id', { preHandler: exigirRol(ADMIN) }, async (peticion, respuesta) => {
    const params = leer(EsquemaIdEnUrl, peticion.params);
    if (params.error) return respuesta.code(400).send({ error: 'identificador invalido' });

    const { datos, error } = leer(EsquemaClienteCambio, peticion.body);
    if (error) return respuesta.code(400).send({ error: 'datos de cliente invalidos', detalles: error });

    const partes = [];
    const valores = { id: params.datos.id, negocio: peticion.usuario.negocio_id };
    for (const campo of ['nombre', 'telefono', 'identificacion', 'limite_credito', 'activo']) {
      if (campo in datos) {
        partes.push(`${campo} = @${campo}`);
        valores[campo] = campo === 'activo' ? (datos[campo] ? 1 : 0) : datos[campo] ?? null;
      }
    }

    try {
      const { rowCount } = await db.query(
        `UPDATE CLIENTE SET ${partes.join(', ')}
          WHERE id = @id AND negocio_id = @negocio`,
        valores,
      );
      if (rowCount === 0) return respuesta.code(404).send({ error: 'cliente no encontrado' });

      // Bajar un limite por debajo del saldo actual NO se rechaza: el saldo ya
      // existe y negarlo no lo borra. Lo que hace es dejar el cupo en negativo,
      // que es la lectura correcta -- "este cliente esta por encima de lo que
      // ahora le autorizamos" -- y el trigger impide que se le fie mas.
      const { rows } = await db.query(
        'SELECT saldo, limite_credito, cupo_disponible FROM v_cuentas_por_cobrar WHERE cliente_id = @id',
        { id: params.datos.id },
      );
      return { actualizado: true, campos: Object.keys(datos), estado: rows[0] ?? null };
    } catch (e) {
      return responderError(e, respuesta, peticion.log, 'fallo al modificar el cliente');
    }
  });
}
