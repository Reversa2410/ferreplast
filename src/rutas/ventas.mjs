// =============================================================================
// Ventas con conexion
//
// POR QUE EXISTE ESTE CAMINO SI YA HAY /sync/push:
// porque el credito no puede entrar por sincronizacion. El limite se comprueba
// contra el saldo del cliente en la base, y dos tiendas sin conexion no se ven
// entre si: las dos le fiarian el limite completo al mismo cliente. Fiar exige
// senial, y por lo tanto exige un camino que solo funcione con senial.
//
// De paso es el camino normal cuando hay internet: la respuesta llega en el
// momento, asi que el vendedor sabe que la venta quedo registrada en lugar de
// confiar en que la cola se vacie despues.
//
// Las dos rutas escriben con la MISMA funcion (dominio/ventas.mjs). La
// diferencia esta en lo que cada una acepta antes de llamarla, no en lo que
// escribe: si fueran dos implementaciones, la primera diferencia entre ellas
// seria una venta que no descuenta stock.
// =============================================================================

import {
  EsquemaVentaDirecta,
  EsquemaAnulacion,
  EsquemaIdEnUrl,
} from '../validacion.mjs';
import { exigirRol, puedeOperarEn, ADMIN } from '../auth/guardia.mjs';
import { insertarVenta, anularVenta } from '../dominio/ventas.mjs';
import { leer, responderError, tiendaDeLaPeticion } from './_ayudas.mjs';

const POR_PAGINA = 100;

export default async function rutasVentas(app, { db }) {
  // ---------------------------------------------------------------------------
  // POST /ventas
  //
  // Registra una venta hecha en el mostrador, con conexion.
  // ---------------------------------------------------------------------------
  app.post('/ventas', async (peticion, respuesta) => {
    const { datos, error } = leer(EsquemaVentaDirecta, peticion.body);
    if (error) return respuesta.code(400).send({ error: 'datos de venta invalidos', detalles: error });

    if (!puedeOperarEn(peticion.usuario, datos.tienda_id)) {
      return respuesta.code(403).send({ error: 'no puede registrar ventas en esa tienda' });
    }

    // El cliente a credito tiene que ser del mismo negocio.
    //
    // La clave foranea garantiza que el cliente EXISTA, no que sea de aca: sin
    // esta comprobacion se podria fiar a nombre de un cliente de otro negocio,
    // y su deuda aparecia en las cuentas por cobrar de esta duenia.
    if (datos.cliente_id != null) {
      const { rows } = await db.query(
        `SELECT c.id
           FROM CLIENTE c
           JOIN TIENDA  t ON t.negocio_id = c.negocio_id
          WHERE c.id = @cliente_id AND t.id = @tienda_id AND c.activo = 1`,
        { cliente_id: datos.cliente_id, tienda_id: datos.tienda_id },
      );
      if (rows.length === 0) {
        return respuesta.code(400).send({ error: 'el cliente no existe o no es de este negocio' });
      }
    }

    // La caja se resuelve aca si no vino: es la que esta abierta en la tienda.
    //
    // POR QUE EL SERVIDOR LA BUSCA EN LUGAR DE PEDIRLA: la pantalla de venta no
    // tiene por que llevar la cuenta de que caja esta abierta, y si se
    // equivocara, el dinero de una venta quedaria contado en el cuadre de otro
    // turno. El indice UX_CAJA_ABIERTA_POR_TIENDA garantiza que haya una sola.
    let cajaId = datos.caja_id ?? null;
    if (cajaId == null) {
      const { rows } = await db.query(
        "SELECT id FROM CAJA WHERE tienda_id = @t AND estado = 'abierta'",
        { t: datos.tienda_id },
      );
      cajaId = rows[0]?.id ?? null;
    }

    // Una venta en efectivo sin caja abierta no tiene donde sumar el dinero, y
    // el cuadre del turno quedaria corto sin que nada avise.
    if (cajaId == null && datos.metodo_pago === 'efectivo') {
      return respuesta.code(409).send({
        error: 'no hay una caja abierta en esta tienda; abra la caja antes de vender en efectivo',
      });
    }

    try {
      const resultado = await insertarVenta(db, {
        ...datos,
        caja_id: cajaId,
        // El autor es quien tiene la sesion: en el camino con conexion no hay
        // razon para aceptar otro, al contrario de la sincronizacion, donde la
        // tablet trae operaciones de varios turnos.
        usuario_id: peticion.usuario.id,
      }, { exigirExistencia: true });

      // 409 y no 400: la venta esta bien armada, es el estado del inventario
      // el que no la admite. El detalle va por producto para que la pantalla
      // pueda ajustar cada linea a lo que hay.
      if (resultado.estado === 'sin_existencia') {
        const texto = resultado.faltantes
          .map((f) => `${f.nombre}: pidio ${f.pedida}, hay ${f.hay}${f.unidad ? ` ${f.unidad}` : ''}`)
          .join('; ');
        return respuesta.code(409).send({
          error: `no hay existencia suficiente. ${texto}`,
          faltantes: resultado.faltantes,
        });
      }

      if (resultado.estado === 'duplicado') {
        return respuesta.code(200).send({
          duplicado: true, id: resultado.id, numero: resultado.numero,
        });
      }

      return respuesta.code(201).send({
        id: resultado.id,
        numero: resultado.numero,
        caja_id: cajaId,
      });
    } catch (e) {
      // El limite de credito llega aca como THROW 50002 desde el trigger, y
      // responderError lo convierte en 409 con el mensaje del esquema: "La
      // venta a credito supera el limite del cliente."
      return responderError(e, respuesta, peticion.log, 'fallo al registrar la venta');
    }
  });

  // ---------------------------------------------------------------------------
  // GET /ventas
  //
  // El historial. El empleado ve el de su tienda; el administrador, el de las
  // dos o el de la que pida.
  // ---------------------------------------------------------------------------
  app.get('/ventas', async (peticion) => {
    const tiendaId = tiendaDeLaPeticion(peticion.usuario, peticion.query.tienda_id);
    const { desde = null, hasta = null, metodo_pago = null } = peticion.query;
    const pagina = Math.max(1, Number(peticion.query.pagina) || 1);

    const { rows } = await db.query(
      `SELECT v.id, v.numero, v.tienda_id, t.nombre AS tienda, v.caja_id,
              v.cliente_id, cl.nombre AS cliente, u.nombre AS vendedor,
              v.subtotal, v.descuento, v.total, v.metodo_pago, v.anulada,
              v.ocurrido_en,
              (SELECT COUNT(*) FROM VENTA_LINEA l WHERE l.venta_id = v.id) AS lineas
         FROM VENTA v
         JOIN TIENDA t ON t.id = v.tienda_id
         LEFT JOIN Usuario u  ON u.id  = v.usuario_id
         LEFT JOIN CLIENTE cl ON cl.id = v.cliente_id
        WHERE (@tienda_id   IS NULL OR v.tienda_id   = @tienda_id)
          AND (@metodo_pago IS NULL OR v.metodo_pago = @metodo_pago)
          -- desde y hasta son dias LOCALES de Nicaragua, y ocurrido_en esta en
          -- UTC: comparar uno contra otro directamente corre el rango seis
          -- horas. Se traducen los dos extremos a UTC una sola vez (ver
          -- db/schema.sql, seccion 3.4), lo que ademas deja el filtro apoyado
          -- en IX_VENTA_FECHA en lugar de convertir cada fila.
          AND (@desde IS NULL
               OR v.ocurrido_en >= dbo.fn_inicio_utc_del_dia(CAST(@desde AS DATE)))
          -- El limite superior es el inicio del dia siguiente, con "<": sumar
          -- 23:59:59 dejaria afuera la venta del ultimo segundo.
          AND (@hasta IS NULL
               OR v.ocurrido_en <  dbo.fn_inicio_utc_del_dia(DATEADD(DAY, 1, CAST(@hasta AS DATE))))
        ORDER BY v.ocurrido_en DESC
        OFFSET @salto ROWS FETCH NEXT @toma ROWS ONLY`,
      {
        tienda_id: tiendaId,
        metodo_pago: metodo_pago || null,
        desde: desde || null,
        hasta: hasta || null,
        salto: (pagina - 1) * POR_PAGINA,
        toma: POR_PAGINA,
      },
    );

    return { pagina, por_pagina: POR_PAGINA, ventas: rows };
  });

  // ---------------------------------------------------------------------------
  // GET /ventas/:id
  //
  // El comprobante completo, con su detalle. Es lo que hay que poder mostrar
  // cuando un cliente vuelve con un reclamo.
  // ---------------------------------------------------------------------------
  app.get('/ventas/:id', async (peticion, respuesta) => {
    const params = leer(EsquemaIdEnUrl, peticion.params);
    if (params.error) return respuesta.code(400).send({ error: 'identificador invalido' });

    const { rows } = await db.query(
      `SELECT v.id, v.numero, v.tienda_id, t.nombre AS tienda, t.prefijo,
              v.caja_id, v.cliente_id, cl.nombre AS cliente,
              u.nombre AS vendedor, v.subtotal, v.descuento, v.total,
              v.metodo_pago, v.anulada, v.observaciones, v.ocurrido_en,
              v.uuid_externo
         FROM VENTA v
         JOIN TIENDA t ON t.id = v.tienda_id
         LEFT JOIN Usuario u  ON u.id  = v.usuario_id
         LEFT JOIN CLIENTE cl ON cl.id = v.cliente_id
        WHERE v.id = @id`,
      { id: params.datos.id },
    );
    const venta = rows[0];
    if (!venta) return respuesta.code(404).send({ error: 'venta no encontrada' });

    // El alcance se comprueba DESPUES de leerla porque hay que saber de que
    // tienda es para decidir, y antes de devolverla. El 404 y el 403 no se
    // mezclan: si no es de su tienda, no se le confirma que exista.
    if (!puedeOperarEn(peticion.usuario, venta.tienda_id)) {
      return respuesta.code(404).send({ error: 'venta no encontrada' });
    }

    const { rows: lineas } = await db.query(
      `SELECT l.numero, l.producto_id, p.codigo, p.nombre AS producto,
              p.unidad_medida, l.cantidad, l.precio_unitario, l.descuento,
              l.subtotal
         FROM VENTA_LINEA l
         JOIN PRODUCTO    p ON p.id = l.producto_id
        WHERE l.venta_id = @id
        ORDER BY l.numero`,
      { id: params.datos.id },
    );

    return { venta, lineas };
  });

  // ---------------------------------------------------------------------------
  // POST /ventas/:id/anular               [administrador]
  //
  // POR QUE SOLO EL ADMINISTRADOR:
  // anular devuelve la mercaderia al stock y saca el importe de las ventas del
  // dia. Es exactamente la operacion que haria quien se queda con el efectivo
  // de una venta: anulandola, la caja cuadra igual al cierre y el stock
  // tampoco delata nada.
  //
  // El costo es real -- un error de tecleo obliga a llamar a la duenia -- y es
  // la decision deliberada: el control sobre el dinero vale mas que la
  // comodidad de corregir sin consultar. Si molesta en la practica, la
  // alternativa es permitirselo al empleado dentro de su propio turno y dejar
  // la anulacion visible en el cuadre de caja, no quitarle el control.
  // ---------------------------------------------------------------------------
  app.post('/ventas/:id/anular', { preHandler: exigirRol(ADMIN) }, async (peticion, respuesta) => {
    const params = leer(EsquemaIdEnUrl, peticion.params);
    if (params.error) return respuesta.code(400).send({ error: 'identificador invalido' });

    const { datos, error } = leer(EsquemaAnulacion, peticion.body);
    if (error) return respuesta.code(400).send({ error: 'falta el motivo de la anulacion', detalles: error });

    try {
      const r = await anularVenta(db, params.datos.id, peticion.usuario.id, datos.motivo);

      if (r.estado === 'no_existe') return respuesta.code(404).send({ error: 'venta no encontrada' });
      if (r.estado === 'ya_anulada') {
        return respuesta.code(409).send({ error: 'esa venta ya estaba anulada' });
      }

      return { anulada: true, numero: r.venta.numero, total_devuelto: Number(r.venta.total) };
    } catch (e) {
      return responderError(e, respuesta, peticion.log, 'fallo al anular la venta');
    }
  });
}
