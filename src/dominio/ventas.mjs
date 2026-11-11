// =============================================================================
// Registro de ventas y movimientos de inventario
//
// POR QUE ESTO NO VIVE EN UNA RUTA:
// hay DOS caminos por los que entra una venta -- /sync/push, con lo que la
// tablet acumulo sin conexion, y POST /ventas, cuando hay senial -- y las dos
// tienen que escribir exactamente lo mismo. Si cada ruta tuviera su propia
// version, la primera diferencia entre ellas seria una venta que no descuenta
// stock, o un total que no coincide con el detalle. Hay una sola
// implementacion y las dos rutas la llaman.
//
// La diferencia entre los dos caminos NO esta aca: esta en lo que cada ruta
// acepta antes de llamar (el credito, por ejemplo, solo entra por el camino
// con conexion).
// =============================================================================

import { esDuplicado } from '../db.mjs';

/**
 * Convierte la fecha que manda el cliente en algo que la base guarde bien.
 *
 * ES NECESARIO Y NO ES COSMETICO: la tablet manda la fecha en ISO con
 * desplazamiento ("...T18:30:00-06:00"). Si esa cadena se pasa tal cual a una
 * columna DATETIME2, SQL Server se queda con la hora de pared y DESCARTA el
 * desplazamiento, asi que una venta de las 18:30 de Nicaragua se guarda como
 * las 18:30 UTC: seis horas de corrimiento, sin ningun error. Un Date de
 * JavaScript, en cambio, el driver lo manda ya en UTC.
 */
export const comoFecha = (iso) => (iso ? new Date(iso) : new Date());

// -----------------------------------------------------------------------------
// Movimiento de inventario suelto
// -----------------------------------------------------------------------------

/**
 * Inserta un movimiento de inventario que no viene de una venta.
 *
 * El INSERT ... SELECT ... WHERE NOT EXISTS es lo que hace segura la
 * reentrega: el segundo envio del mismo uuid_externo no inserta nada, y
 * rowCount lo dice sin necesidad de consultar antes.
 *
 * El indice unico queda igual como ultima defensa: si dos envios de la misma
 * operacion llegan a la vez, el NOT EXISTS puede dar verdadero en los dos y es
 * el indice el que frena al segundo. Ese caso se trata como duplicado, que es
 * lo que es.
 *
 * Sin uuid_externo (un ajuste hecho desde el panel, que nadie va a reenviar)
 * el NOT EXISTS no filtra nada y el movimiento entra siempre.
 */
export async function insertarMovimiento(db, m) {
  try {
    const { rowCount } = await db.query(
      `INSERT INTO MOVIMIENTO_INVENTARIO
           (uuid_externo, tienda_id, producto_id, usuario_id, tipo, cantidad,
            costo_unitario, motivo, ocurrido_en)
       SELECT @uuid_externo, @tienda_id, @producto_id, @usuario_id, @tipo,
              CAST(@cantidad AS DECIMAL(18,3)), @costo_unitario, @motivo, @ocurrido_en
        WHERE @uuid_externo IS NULL
           OR NOT EXISTS (
              SELECT 1 FROM MOVIMIENTO_INVENTARIO WHERE uuid_externo = @uuid_externo)`,
      {
        uuid_externo: m.uuid_externo ?? null,
        tienda_id: m.tienda_id,
        producto_id: m.producto_id,
        usuario_id: m.usuario_id ?? null,
        tipo: m.tipo,
        cantidad: m.cantidad,
        costo_unitario: m.costo_unitario ?? null,
        motivo: m.motivo ?? null,
        ocurrido_en: comoFecha(m.ocurrido_en),
      },
    );
    return { estado: rowCount > 0 ? 'aceptado' : 'duplicado' };
  } catch (e) {
    if (esDuplicado(e)) return { estado: 'duplicado' };
    throw e;
  }
}

// -----------------------------------------------------------------------------
// Venta completa
// -----------------------------------------------------------------------------

/**
 * Inserta una venta completa: cabecera, lineas y movimientos de stock.
 *
 * Todo dentro de UNA transaccion. Lo primero es buscar el uuid_externo: si ya
 * esta, se corta ahi sin tocar nada. Ese chequeo es lo que evita que un reenvio
 * duplique las lineas y descuente el stock dos veces.
 *
 * Los movimientos de inventario NO vienen del cliente: se derivan aca de las
 * lineas. Asi es estructuralmente imposible que exista una venta sin su
 * descuento de stock correspondiente.
 *
 * POR QUE LOS IMPORTES SE CALCULAN EN SQL Y NO EN JAVASCRIPT:
 * la base exige subtotal = ROUND(cantidad * precio, 2) - descuento. Si ese
 * numero se calculara aca con numeros de punto flotante y la base lo
 * recalculara en DECIMAL, bastaria un caso de redondeo al borde para que la
 * restriccion rechace una venta valida. Calculandolo con la misma aritmetica
 * decimal que la restriccion, no hay forma de que no coincidan.
 */
export async function insertarVenta(db, v) {
  return db.tx(async (tx) => {
    // Solo tiene sentido buscar un duplicado si la venta trae su clave de
    // idempotencia. Una venta hecha con conexion no la necesita: la respuesta
    // llega, y si no llega el vendedor lo ve en la pantalla.
    if (v.uuid_externo) {
      const yaEsta = await tx.query(
        'SELECT id, numero FROM VENTA WHERE uuid_externo = @uuid_externo',
        { uuid_externo: v.uuid_externo },
      );
      if (yaEsta.rows.length > 0) {
        return { estado: 'duplicado', id: yaEsta.rows[0].id, numero: yaEsta.rows[0].numero };
      }
    }

    // EL NUMERO DE VENTA LO ASIGNA EL SERVIDOR.
    //
    // Es unico por tienda (UQ_VENTA_NUMERO). Si lo eligiera la tablet, dos
    // tablets sin conexion en el mismo local elegirian el mismo y la segunda
    // venta en llegar seria rechazada por un problema que el vendedor no puede
    // entender ni arreglar.
    //
    // UPDLOCK + HOLDLOCK serializa la numeracion por tienda: sin ellos, dos
    // sincronizaciones simultaneas leen el mismo maximo y una de las dos choca
    // contra el indice unico.
    const siguiente = await tx.query(
      `SELECT ISNULL(MAX(numero), 0) + 1 AS numero
         FROM VENTA WITH (UPDLOCK, HOLDLOCK)
        WHERE tienda_id = @tienda_id`,
      { tienda_id: v.tienda_id },
    );
    const numero = siguiente.rows[0].numero;

    // La cabecera entra con los importes en cero y se completa al final a
    // partir de las lineas. Asi el total guardado es, por construccion, la suma
    // de lo que se vendio: no hay un camino en que la cabecera diga una cosa y
    // el detalle otra.
    //
    // POR QUE OUTPUT ... INTO UNA TABLA Y NO "OUTPUT INSERTED.id" A SECAS:
    // VENTA tiene un trigger (el del limite de credito), y SQL Server rechaza
    // un OUTPUT sin INTO sobre cualquier tabla con triggers habilitados
    // (error 334). La tabla intermedia es el precio de tener el trigger.
    const cabecera = await tx.query(
      `DECLARE @nueva TABLE (id INT);
       INSERT INTO VENTA
           (uuid_externo, tienda_id, usuario_id, caja_id, cliente_id, numero,
            metodo_pago, observaciones, ocurrido_en)
       OUTPUT INSERTED.id INTO @nueva
       VALUES (@uuid_externo, @tienda_id, @usuario_id, @caja_id, @cliente_id, @numero,
               @metodo_pago, @observaciones, @ocurrido_en);
       SELECT id FROM @nueva;`,
      {
        uuid_externo: v.uuid_externo ?? null,
        tienda_id: v.tienda_id,
        usuario_id: v.usuario_id ?? null,
        caja_id: v.caja_id ?? null,
        cliente_id: v.cliente_id ?? null,
        numero,
        metodo_pago: v.metodo_pago,
        observaciones: v.observaciones ?? null,
        ocurrido_en: comoFecha(v.ocurrido_en),
      },
    );
    const ventaId = cabecera.rows[0].id;
    const ocurridoEn = comoFecha(v.ocurrido_en);

    for (const [indice, l] of v.lineas.entries()) {
      await tx.query(
        `INSERT INTO VENTA_LINEA
             (venta_id, numero, producto_id, cantidad, precio_unitario,
              costo_unitario, descuento, subtotal)
         VALUES (@venta_id, @numero, @producto_id,
                 CAST(@cantidad AS DECIMAL(18,3)),
                 CAST(@precio_unitario AS DECIMAL(18,2)),
                 CAST(@costo_unitario  AS DECIMAL(18,2)),
                 CAST(@descuento       AS DECIMAL(18,2)),
                 ROUND(CAST(@cantidad AS DECIMAL(18,3))
                     * CAST(@precio_unitario AS DECIMAL(18,2)), 2)
                     - CAST(@descuento AS DECIMAL(18,2)))`,
        {
          venta_id: ventaId,
          numero: indice + 1,
          producto_id: l.producto_id,
          cantidad: l.cantidad,
          precio_unitario: l.precio_unitario,
          costo_unitario: l.costo_unitario,
          descuento: l.descuento,
        },
      );

      // Salida de stock por la venta: cantidad negativa, enlazada a la venta.
      //
      // Sin uuid_externo: este movimiento no lo nombro ningun cliente, lo
      // derivo el servidor. El indice unico es filtrado (WHERE uuid_externo IS
      // NOT NULL), asi que admite todos los nulos que haga falta.
      await tx.query(
        `INSERT INTO MOVIMIENTO_INVENTARIO
             (tienda_id, producto_id, usuario_id, tipo, cantidad,
              costo_unitario, venta_id, ocurrido_en)
         VALUES (@tienda_id, @producto_id, @usuario_id, 'venta',
                 -ABS(CAST(@cantidad AS DECIMAL(18,3))),
                 CAST(@costo_unitario AS DECIMAL(18,2)), @venta_id, @ocurrido_en)`,
        {
          tienda_id: v.tienda_id,
          producto_id: l.producto_id,
          usuario_id: v.usuario_id ?? null,
          cantidad: l.cantidad,
          costo_unitario: l.costo_unitario,
          venta_id: ventaId,
          ocurrido_en: ocurridoEn,
        },
      );
    }

    // Este UPDATE es el que dispara el trigger del limite de credito con el
    // total de verdad: en el INSERT de la cabecera el total era cero y pasaba
    // siempre. Si el cliente se pasa del limite, la excepcion salta aca y la
    // transaccion entera se revierte -- venta, lineas y movimientos.
    await tx.query(
      `UPDATE v
          SET subtotal  = x.bruto,
              descuento = x.rebaja,
              total     = x.bruto - x.rebaja
         FROM VENTA v
         JOIN (SELECT venta_id,
                      SUM(ROUND(cantidad * precio_unitario, 2)) AS bruto,
                      SUM(descuento)                            AS rebaja
                 FROM VENTA_LINEA
                WHERE venta_id = @venta_id
                GROUP BY venta_id) x ON x.venta_id = v.id
        WHERE v.id = @venta_id`,
      { venta_id: ventaId },
    );

    return { estado: 'aceptado', id: ventaId, numero };
  });
}

/**
 * Anula una venta sin borrarla, y devuelve la mercaderia al stock.
 *
 * POR QUE NO SE BORRA: el comprobante existio, el cliente se fue con un papel
 * en la mano y el numero de venta no puede reaparecer en otra. Lo que hay que
 * poder reconstruir despues es que se anulo y cuando.
 *
 * El stock vuelve con movimientos de tipo 'devolucion', no editando los de la
 * venta: el historial de inventario es inmutable por trigger (THROW 50001), y
 * ademas la devolucion es un hecho que paso y merece su propia linea.
 */
export async function anularVenta(db, ventaId, usuarioId, motivo) {
  return db.tx(async (tx) => {
    const { rows } = await tx.query(
      `SELECT id, tienda_id, anulada, numero, total, ocurrido_en
         FROM VENTA WHERE id = @id`,
      { id: ventaId },
    );
    const venta = rows[0];
    if (!venta) return { estado: 'no_existe' };
    if (venta.anulada) return { estado: 'ya_anulada', venta };

    // La devolucion al stock va antes de marcar la anulacion para que, si algo
    // falla al reponer, la venta no quede anulada sin que la mercaderia vuelva.
    await tx.query(
      `INSERT INTO MOVIMIENTO_INVENTARIO
           (tienda_id, producto_id, usuario_id, tipo, cantidad,
            costo_unitario, venta_id, motivo, ocurrido_en)
       SELECT @tienda_id, l.producto_id, @usuario_id, 'devolucion',
              l.cantidad, l.costo_unitario, @venta_id, @motivo, SYSUTCDATETIME()
         FROM VENTA_LINEA l
        WHERE l.venta_id = @venta_id`,
      {
        tienda_id: venta.tienda_id,
        usuario_id: usuarioId ?? null,
        venta_id: ventaId,
        motivo: motivo ?? `anulacion de la venta ${venta.numero}`,
      },
    );

    await tx.query(
      `UPDATE VENTA
          SET anulada = 1,
              observaciones = ISNULL(observaciones + ' | ', '') + @nota
        WHERE id = @id`,
      { id: ventaId, nota: `ANULADA: ${motivo ?? 'sin motivo indicado'}` },
    );

    return { estado: 'anulada', venta };
  });
}
