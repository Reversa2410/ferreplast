// =============================================================================
// Sincronizacion offline  <-- NUCLEO DE LA API
//
// Las tablets trabajan sin conexion y acumulan operaciones. Cuando vuelve la
// senial las envian aca.
//
// Tres propiedades que este endpoint debe cumplir si o si:
//
//   1. IDEMPOTENCIA. La tablet no sabe si su envio anterior llego (la respuesta
//      pudo perderse). Reintenta. Reenviar mil veces la misma venta tiene que
//      dar el mismo resultado que enviarla una vez.
//
//   2. AISLAMIENTO ENTRE ELEMENTOS. Un registro corrupto no puede bloquear el
//      lote entero: si de 50 ventas del dia una viene mal, las otras 49 tienen
//      que entrar igual. Por eso cada elemento se procesa en su propia
//      transaccion y los errores se informan uno por uno.
//
//   3. ATOMICIDAD POR VENTA. Una venta son tres escrituras (cabecera, lineas y
//      movimientos de stock). O entran las tres o no entra ninguna. Una venta
//      registrada que no descuente stock es peor que no registrarla.
// =============================================================================

import { randomUUID } from 'node:crypto';
import {
  EsquemaMovimiento,
  EsquemaVenta,
  formatearErrores,
} from '../validacion.mjs';
import { exigirRol, puedeOperarEn } from '../auth/guardia.mjs';

const LIMITE_LOTE = 500;

/**
 * Inserta un movimiento suelto (entrada, merma, ajuste, devolucion).
 *
 * ON CONFLICT DO NOTHING sobre la clave primaria es lo que hace segura la
 * reentrega: el segundo envio del mismo id no hace nada. RETURNING permite
 * distinguir "se inserto" de "ya estaba".
 */
async function insertarMovimiento(db, m) {
  const { rows } = await db.query(
    `INSERT INTO movimientos_inventario
       (id, tienda_id, producto_id, usuario_id, tipo, cantidad,
        costo_unitario, motivo, ocurrido_en)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (id) DO NOTHING
     RETURNING id`,
    [m.id, m.tienda_id, m.producto_id, m.usuario_id ?? null, m.tipo,
     m.cantidad, m.costo_unitario ?? null, m.motivo ?? null, m.ocurrido_en],
  );
  return rows.length > 0 ? 'aceptado' : 'duplicado';
}

/**
 * Inserta una venta completa: cabecera, lineas y movimientos de stock.
 *
 * Todo dentro de UNA transaccion. La cabecera se inserta primero con
 * ON CONFLICT DO NOTHING: si no devuelve fila, la venta ya existia y se corta
 * ahi sin tocar nada mas. Ese chequeo es lo que evita que un reenvio duplique
 * las lineas y descuente el stock dos veces.
 *
 * Los movimientos de inventario NO vienen del cliente: se derivan aca de las
 * lineas. Asi es estructuralmente imposible que exista una venta sin su
 * descuento de stock correspondiente.
 */
async function insertarVenta(db, v) {
  return db.tx(async (tx) => {
    const cabecera = await tx.query(
      `INSERT INTO ventas
         (id, tienda_id, usuario_id, caja_id, numero, subtotal, descuento,
          total, metodo_pago, observaciones, ocurrido_en)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      [v.id, v.tienda_id, v.usuario_id ?? null, v.caja_id ?? null, v.numero,
       v.subtotal, v.descuento, v.total, v.metodo_pago,
       v.observaciones ?? null, v.ocurrido_en],
    );

    // Ya estaba: no se reprocesa nada. Esta es la clave de la idempotencia.
    if (cabecera.rows.length === 0) return 'duplicado';

    for (const l of v.lineas) {
      await tx.query(
        `INSERT INTO venta_lineas
           (venta_id, producto_id, cantidad, precio_unitario, costo_unitario, subtotal)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [v.id, l.producto_id, l.cantidad, l.precio_unitario, l.costo_unitario, l.subtotal],
      );

      // Salida de stock por la venta: cantidad negativa, enlazada a la venta.
      // El id se genera aca y no se repite, porque a este punto solo se llega
      // la primera vez que la venta entra.
      await tx.query(
        `INSERT INTO movimientos_inventario
           (id, tienda_id, producto_id, usuario_id, tipo, cantidad,
            costo_unitario, venta_id, ocurrido_en)
         VALUES ($1,$2,$3,$4,'venta',$5,$6,$7,$8)`,
        [randomUUID(), v.tienda_id, l.producto_id, v.usuario_id ?? null,
         -Math.abs(l.cantidad), l.costo_unitario, v.id, v.ocurrido_en],
      );
    }

    return 'aceptado';
  });
}

/**
 * Procesa una lista de elementos de forma independiente entre si.
 *
 * Valida y aplica uno por uno. Si uno falla, se registra el motivo y se sigue
 * con el resto: el objetivo es que la tablet pueda descartar de su cola todo lo
 * que el servidor confirmo, y apartar solo lo que dio problema.
 */
async function procesarLote(db, elementos, esquema, insertar, usuario, log) {
  const resultado = { aceptados: 0, duplicados: 0, rechazados: [] };

  for (const bruto of elementos) {
    const validacion = esquema.safeParse(bruto);

    if (!validacion.success) {
      resultado.rechazados.push({
        id: bruto?.id ?? null,
        motivo: 'validacion',
        detalles: formatearErrores(validacion.error),
      });
      continue;
    }

    // El empleado solo puede escribir en SU tienda. Se comprueba por elemento y
    // no de una vez para el lote entero porque el lote puede traer de las dos:
    // asi entra lo que corresponde y se aparta solo lo que no, igual que con
    // los errores de validacion.
    //
    // Se valida la TIENDA, no el usuario_id del elemento.
    //
    // POR QUE NO SE FUERZA usuario_id AL DE LA SESION: la tablet acumula las
    // operaciones del dia, y durante ese dia pudieron atenderla dos empleados
    // distintos, cada uno con su ingreso. Quien sincroniza al final no es
    // necesariamente quien vendio. Sobrescribir el autor con el de la sesion
    // atribuiria todas las ventas del dia al ultimo que toco la tablet, que es
    // justo lo contrario de lo que la auditoria necesita.
    //
    // PENDIENTE: falta comprobar que ese usuario_id pertenezca a la misma
    // tienda. Hoy la clave foranea garantiza que el usuario exista, pero no que
    // sea de ahi: un empleado podria atribuirle una venta a alguien de la otra
    // tienda. No permite robar ni alterar dinero -- los importes y el stock se
    // validan aparte -- pero ensucia el historial.
    if (!puedeOperarEn(usuario, validacion.data.tienda_id)) {
      resultado.rechazados.push({
        id: validacion.data.id,
        motivo: 'permiso',
        detalles: 'no puede registrar operaciones en esa tienda',
      });
      continue;
    }

    try {
      const estado = await insertar(db, validacion.data);
      if (estado === 'aceptado') resultado.aceptados++;
      else resultado.duplicados++;
    } catch (e) {
      // Errores de la base: clave foranea inexistente (un producto que la
      // tablet tiene y el servidor no), violacion de restriccion, etc.
      //
      // El detalle completo va al registro del servidor, no a la respuesta: el
      // mensaje de PostgreSQL nombra tablas, columnas y restricciones, y eso es
      // un mapa de la base para quien no deberia tenerlo. A la tablet le basta
      // con saber que ese elemento no entro para apartarlo de su cola.
      log?.error({ err: e, id: validacion.data.id }, 'fallo al sincronizar elemento');
      resultado.rechazados.push({
        id: validacion.data.id,
        motivo: 'base_de_datos',
        detalles: 'el servidor no pudo registrar este elemento',
      });
    }
  }

  return resultado;
}

export default async function rutasSync(app, { db }) {
  // ---------------------------------------------------------------------------
  // POST /sync/push
  //
  // Recibe lo que la tablet acumulo sin conexion.
  //
  // Responde SIEMPRE 200 aunque haya elementos rechazados: el lote no fracasa
  // por culpa de un registro malo. La tablet mira el detalle para saber que
  // borrar de su cola y que apartar.
  // ---------------------------------------------------------------------------
  app.post('/sync/push', async (peticion, respuesta) => {
    const cuerpo = peticion.body ?? {};
    const movimientos = Array.isArray(cuerpo.movimientos) ? cuerpo.movimientos : [];
    const ventas = Array.isArray(cuerpo.ventas) ? cuerpo.ventas : [];

    if (movimientos.length > LIMITE_LOTE || ventas.length > LIMITE_LOTE) {
      return respuesta.code(413).send({
        error: `un lote admite hasta ${LIMITE_LOTE} elementos de cada tipo; envie la cola en partes`,
      });
    }

    const resMovimientos = await procesarLote(
      db, movimientos, EsquemaMovimiento, insertarMovimiento, peticion.usuario, peticion.log);
    const resVentas = await procesarLote(
      db, ventas, EsquemaVenta, insertarVenta, peticion.usuario, peticion.log);

    // Bitacora de sincronizacion: permite detectar desde el panel que una
    // tablet dejo de sincronizar, que suele ser el primer sintoma de problema.
    if (cuerpo.dispositivo_id) {
      try {
        await db.query(
          `INSERT INTO sync_log
             (dispositivo_id, registros_enviados, registros_aceptados, registros_duplicados)
           VALUES ($1,$2,$3,$4)`,
          [cuerpo.dispositivo_id,
           movimientos.length + ventas.length,
           resMovimientos.aceptados + resVentas.aceptados,
           resMovimientos.duplicados + resVentas.duplicados],
        );
        await db.query(
          `UPDATE dispositivos SET ultimo_sync = NOW() WHERE id = $1`,
          [cuerpo.dispositivo_id],
        );
      } catch (e) {
        // Un dispositivo no registrado no debe hacer fracasar la sincronizacion
        // de datos reales: se deja constancia y se sigue.
        peticion.log.warn({ err: e }, 'no se pudo registrar la bitacora de sync');
      }
    }

    return {
      sincronizado_en: new Date().toISOString(),
      movimientos: resMovimientos,
      ventas: resVentas,
    };
  });

  // ---------------------------------------------------------------------------
  // GET /sync/catalogo/:tiendaId
  //
  // Lo que la tablet necesita para trabajar sin conexion: el catalogo con sus
  // precios y el stock de su tienda.
  //
  // Se envia completo en lugar de solo los cambios desde la ultima vez. Con
  // cientos de productos son unos pocos cientos de kilobytes, y evita toda una
  // familia de errores sutiles de cursores que se saltean filas cuando dos
  // transacciones confirman en distinto orden. Si el catalogo creciera a
  // decenas de miles de articulos, habria que revisar esta decision.
  // ---------------------------------------------------------------------------
  app.get('/sync/catalogo/:tiendaId', async (peticion, respuesta) => {
    const { tiendaId } = peticion.params;

    // Se responde 403 antes de consultar: si no se puede operar en esa tienda,
    // tampoco hay que confirmar si existe.
    if (!puedeOperarEn(peticion.usuario, tiendaId)) {
      return respuesta.code(403).send({ error: 'no tiene acceso a esa tienda' });
    }

    const tienda = await db.query(
      `SELECT id, nombre, tipo, prefijo FROM tiendas WHERE id = $1 AND activo`,
      [tiendaId],
    );
    if (tienda.rows.length === 0) {
      return respuesta.code(404).send({ error: 'tienda no encontrada' });
    }

    const { rows: productos } = await db.query(
      `SELECT p.id, p.codigo, p.nombre, p.unidad_medida,
              p.precio_costo, p.precio_venta, p.categoria_id,
              COALESCE(s.cantidad, 0)        AS stock,
              COALESCE(s.cantidad_minima, 0) AS stock_minimo
         FROM productos p
         LEFT JOIN stock s
                ON s.producto_id = p.id AND s.tienda_id = $1
        WHERE p.activo
          AND p.negocio_id = (SELECT negocio_id FROM tiendas WHERE id = $1)
        ORDER BY p.nombre`,
      [tiendaId],
    );

    return {
      tienda: tienda.rows[0],
      generado_en: new Date().toISOString(),
      productos,
    };
  });

  // ---------------------------------------------------------------------------
  // GET /sync/estado
  //
  // Alimenta el aviso del panel: "la tablet de la plastiqueria no sincroniza
  // hace 3 horas".
  //
  // Es del panel del duenio, asi que es solo para el admin: muestra las tablets
  // de las dos tiendas juntas.
  // ---------------------------------------------------------------------------
  app.get('/sync/estado', { preHandler: exigirRol('admin') }, async () => {
    const { rows } = await db.query(
      `SELECT d.id, d.nombre, t.nombre AS tienda, d.ultimo_sync,
              EXTRACT(EPOCH FROM (NOW() - d.ultimo_sync))/60 AS minutos_sin_sincronizar
         FROM dispositivos d
         JOIN tiendas t ON t.id = d.tienda_id
        ORDER BY d.ultimo_sync NULLS FIRST`,
    );
    return { dispositivos: rows };
  });
}
