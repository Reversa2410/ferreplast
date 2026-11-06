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
//
// COMO SE LOGRA LA IDEMPOTENCIA EN ESTE MODELO:
// Las claves primarias son INT IDENTITY, o sea que las asigna la base y el
// cliente no puede nombrar una operacion antes de enviarla. Para eso existe
// uuid_externo: lo genera la tablet, viaja con el registro y tiene un indice
// unico filtrado. Es la unica columna que permite reconocer un reenvio.
// =============================================================================

import {
  EsquemaMovimiento,
  EsquemaVenta,
  EsquemaTiendaEnUrl,
  formatearErrores,
} from '../validacion.mjs';
import { exigirRol, puedeOperarEn, ADMIN } from '../auth/guardia.mjs';
import { esDuplicado } from '../db.mjs';

const LIMITE_LOTE = 500;

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
const comoFecha = (iso) => new Date(iso);

// -----------------------------------------------------------------------------
// Insercion de un movimiento suelto
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
 */
async function insertarMovimiento(db, m) {
  try {
    const { rowCount } = await db.query(
      `INSERT INTO MOVIMIENTO_INVENTARIO
           (uuid_externo, tienda_id, producto_id, usuario_id, tipo, cantidad,
            costo_unitario, motivo, ocurrido_en)
       SELECT @uuid_externo, @tienda_id, @producto_id, @usuario_id, @tipo,
              CAST(@cantidad AS DECIMAL(18,3)), @costo_unitario, @motivo, @ocurrido_en
        WHERE NOT EXISTS (
            SELECT 1 FROM MOVIMIENTO_INVENTARIO WHERE uuid_externo = @uuid_externo)`,
      {
        uuid_externo: m.uuid_externo,
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
// Insercion de una venta completa
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
async function insertarVenta(db, v) {
  return db.tx(async (tx) => {
    const yaEsta = await tx.query(
      'SELECT id, numero FROM VENTA WHERE uuid_externo = @uuid_externo',
      { uuid_externo: v.uuid_externo },
    );
    if (yaEsta.rows.length > 0) {
      return { estado: 'duplicado', id: yaEsta.rows[0].id, numero: yaEsta.rows[0].numero };
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
        uuid_externo: v.uuid_externo,
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

// -----------------------------------------------------------------------------
// Reglas que se aplican solo a lo que llega por sincronizacion
// -----------------------------------------------------------------------------

/**
 * Una venta que llega por /sync/push es, por definicion, una que se hizo sin
 * conexion. El credito no puede entrar por aca.
 *
 * POR QUE: el limite de credito se comprueba contra el saldo del cliente en la
 * base. Dos tiendas sin conexion no pueden ver el saldo ni verse entre si, asi
 * que las dos le fiarian hasta el limite completo al mismo cliente y el exceso
 * recien aparecia al sincronizar -- cuando la mercaderia ya salio y el
 * descubierto es un hecho. Rechazarlo aca significa que fiar exige senial, que
 * es una restriccion que el negocio puede manejar: el credito es una decision
 * que se toma de a una.
 */
function reglasDeSincronizacion(venta) {
  if (venta.metodo_pago === 'credito') {
    return 'el credito necesita conexion: no se puede fiar sin consultar el saldo del cliente';
  }
  return null;
}

// -----------------------------------------------------------------------------
// Procesamiento del lote
// -----------------------------------------------------------------------------

/**
 * Procesa una lista de elementos de forma independiente entre si.
 *
 * Valida y aplica uno por uno. Si uno falla, se registra el motivo y se sigue
 * con el resto: el objetivo es que la tablet pueda descartar de su cola todo lo
 * que el servidor confirmo, y apartar solo lo que dio problema.
 */
async function procesarLote(db, elementos, esquema, insertar, usuario, log, reglas = null) {
  const resultado = { aceptados: 0, duplicados: 0, rechazados: [], asignados: [] };

  for (const bruto of elementos) {
    const validacion = esquema.safeParse(bruto);

    if (!validacion.success) {
      resultado.rechazados.push({
        uuid_externo: bruto?.uuid_externo ?? null,
        motivo: 'validacion',
        detalles: formatearErrores(validacion.error),
      });
      continue;
    }

    const elemento = validacion.data;

    // El empleado solo puede escribir en la tienda de su sesion. Se comprueba
    // por elemento y no de una vez para el lote entero porque el lote puede
    // traer de las dos: asi entra lo que corresponde y se aparta solo lo que
    // no, igual que con los errores de validacion.
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
    // PENDIENTE: falta comprobar que ese usuario_id este asignado a la misma
    // tienda. Hoy la clave foranea garantiza que el usuario exista, pero no que
    // trabaje ahi: un empleado podria atribuirle una venta a alguien de la otra
    // tienda. No permite robar ni alterar dinero -- los importes y el stock se
    // validan aparte -- pero ensucia el historial.
    if (!puedeOperarEn(usuario, elemento.tienda_id)) {
      resultado.rechazados.push({
        uuid_externo: elemento.uuid_externo,
        motivo: 'permiso',
        detalles: 'no puede registrar operaciones en esa tienda',
      });
      continue;
    }

    const problema = reglas?.(elemento);
    if (problema) {
      resultado.rechazados.push({
        uuid_externo: elemento.uuid_externo,
        motivo: 'regla',
        detalles: problema,
      });
      continue;
    }

    try {
      const { estado, id, numero } = await insertar(db, elemento);
      if (estado === 'aceptado') resultado.aceptados++;
      else resultado.duplicados++;

      // La tablet necesita saber con que numero quedo la venta: lo asigna el
      // servidor, asi que es la unica forma de que el comprobante que guarda
      // coincida con el que quedo en la base.
      if (id != null) {
        resultado.asignados.push({ uuid_externo: elemento.uuid_externo, id, numero, estado });
      }
    } catch (e) {
      // Errores de la base: clave foranea inexistente (un producto que la
      // tablet tiene y el servidor no), violacion de restriccion, etc.
      //
      // El detalle completo va al registro del servidor, no a la respuesta: el
      // mensaje de SQL Server nombra tablas, columnas y restricciones, y eso es
      // un mapa de la base para quien no deberia tenerlo. A la tablet le basta
      // con saber que ese elemento no entro para apartarlo de su cola.
      log?.error({ err: e, uuid: elemento.uuid_externo }, 'fallo al sincronizar elemento');
      resultado.rechazados.push({
        uuid_externo: elemento.uuid_externo,
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
      db, movimientos, EsquemaMovimiento, insertarMovimiento,
      peticion.usuario, peticion.log);

    const resVentas = await procesarLote(
      db, ventas, EsquemaVenta, insertarVenta,
      peticion.usuario, peticion.log, reglasDeSincronizacion);

    // Bitacora de sincronizacion: permite detectar desde el panel que una
    // tablet dejo de sincronizar, que suele ser el primer sintoma de problema.
    if (cuerpo.dispositivo_id) {
      try {
        await db.query(
          `INSERT INTO SYNC_LOG
               (dispositivo_id, registros_enviados, registros_aceptados, registros_duplicados)
           VALUES (@dispositivo_id, @enviados, @aceptados, @duplicados)`,
          {
            dispositivo_id: Number(cuerpo.dispositivo_id),
            enviados: movimientos.length + ventas.length,
            aceptados: resMovimientos.aceptados + resVentas.aceptados,
            duplicados: resMovimientos.duplicados + resVentas.duplicados,
          },
        );
        await db.query(
          'UPDATE DISPOSITIVO SET ultimo_sync = SYSUTCDATETIME() WHERE id = @id',
          { id: Number(cuerpo.dispositivo_id) },
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
    const params = EsquemaTiendaEnUrl.safeParse(peticion.params);
    if (!params.success) {
      return respuesta.code(400).send({ error: 'identificador de tienda invalido' });
    }
    const { tiendaId } = params.data;

    // Se responde 403 antes de consultar: si no se puede operar en esa tienda,
    // tampoco hay que confirmar si existe.
    if (!puedeOperarEn(peticion.usuario, tiendaId)) {
      return respuesta.code(403).send({ error: 'no tiene acceso a esa tienda' });
    }

    const tienda = await db.query(
      'SELECT id, nombre, tipo, prefijo FROM TIENDA WHERE id = @id AND activo = 1',
      { id: tiendaId },
    );
    if (tienda.rows.length === 0) {
      return respuesta.code(404).send({ error: 'tienda no encontrada' });
    }

    // El catalogo de productos es del negocio, no de la tienda: los dos locales
    // venden del mismo catalogo. Lo que es por tienda es el STOCK, y por eso el
    // join lleva el tienda_id adentro en lugar de un WHERE: con un WHERE, un
    // producto que esa tienda nunca tuvo desapareceria de la lista en vez de
    // aparecer con stock cero.
    const { rows: productos } = await db.query(
      `SELECT p.id, p.codigo, p.nombre, p.unidad_medida,
              p.precio_costo, p.precio_venta, p.categoria_id,
              ISNULL(s.cantidad, 0)        AS stock,
              ISNULL(s.cantidad_minima, 0) AS stock_minimo
         FROM PRODUCTO p
         LEFT JOIN Stock s
                ON s.producto_id = p.id
               AND s.tienda_id   = @tienda_id
        WHERE p.activo = 1
        ORDER BY p.nombre`,
      { tienda_id: tiendaId },
    );

    // Las categorias viajan con el catalogo porque la pantalla de venta agrupa
    // por ellas. Sin esto la tablet mostraria numeros de categoria.
    const { rows: categorias } = await db.query(
      'SELECT id, nombre, padre_id FROM CATEGORIA ORDER BY nombre',
    );

    return {
      tienda: tienda.rows[0],
      generado_en: new Date().toISOString(),
      categorias,
      productos,
    };
  });

  // ---------------------------------------------------------------------------
  // GET /sync/estado
  //
  // Alimenta el aviso del panel: "la tablet de la plastiqueria no sincroniza
  // hace 3 horas".
  //
  // Es del panel de la duenia, asi que es solo para el administrador: muestra
  // las tablets de las dos tiendas juntas.
  // ---------------------------------------------------------------------------
  app.get('/sync/estado', { preHandler: exigirRol(ADMIN) }, async () => {
    // El orden pone primero las que NUNCA sincronizaron, que son las mas
    // urgentes. T-SQL no tiene NULLS FIRST, asi que el CASE lo expresa.
    const { rows } = await db.query(
      `SELECT d.id, d.nombre, t.nombre AS tienda, d.ultimo_sync,
              DATEDIFF(MINUTE, d.ultimo_sync, SYSUTCDATETIME()) AS minutos_sin_sincronizar
         FROM DISPOSITIVO d
         JOIN TIENDA      t ON t.id = d.tienda_id
        WHERE d.activo = 1
        ORDER BY CASE WHEN d.ultimo_sync IS NULL THEN 0 ELSE 1 END, d.ultimo_sync`,
    );
    return { dispositivos: rows };
  });
}
