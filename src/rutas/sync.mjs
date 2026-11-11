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
import { insertarMovimiento, insertarVenta } from '../dominio/ventas.mjs';
import { dispositivoValido } from './dispositivos.mjs';

const LIMITE_LOTE = 500;

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

/**
 * El AJUSTE es la unica operacion que puede hacer desaparecer mercaderia sin
 * una venta detras, y por eso es del administrador. POST /inventario/movimientos
 * ya lo exigia; por aca no habia regla, y un empleado podia mandar un ajuste
 * negativo por la cola y el servidor lo aceptaba (prueba 32). Las dos puertas
 * tienen que tener la misma cerradura.
 */
function reglasDeMovimiento(movimiento, usuario) {
  if (movimiento.tipo === 'ajuste' && usuario.rol !== ADMIN) {
    return 'un ajuste de inventario lo registra el administrador';
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

    const problema = reglas?.(elemento, usuario);
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
      peticion.usuario, peticion.log, reglasDeMovimiento);

    const resVentas = await procesarLote(
      db, ventas, EsquemaVenta, insertarVenta,
      peticion.usuario, peticion.log, reglasDeSincronizacion);

    // Bitacora de sincronizacion: permite detectar desde el panel que una
    // tablet dejo de sincronizar, que suele ser el primer sintoma de problema.
    //
    // Solo cuenta si la tablet existe, esta activa y es de una tienda de quien
    // envia. Antes se aceptaba cualquier id: un empleado de la ferreteria podia
    // poner "al dia" la tablet de la plastiqueria, y el aviso del panel dejaba
    // de valer (prueba 34). Un id que no cumple se ignora: las ventas del lote
    // son reales y entran igual.
    //
    // Un envio VACIO (la tablet no tiene nada que mandar) tambien la pone al
    // dia: esta encendida y con senial. Pero no deja fila en SYNC_LOG, que
    // con un aviso por minuto se llenaria de filas sin contenido.
    const dispositivo = await dispositivoValido(db, peticion.usuario, cuerpo.dispositivo_id);
    if (dispositivo) {
      try {
        const enviados = movimientos.length + ventas.length;
        if (enviados > 0) {
          await db.query(
            `INSERT INTO SYNC_LOG
                 (dispositivo_id, registros_enviados, registros_aceptados, registros_duplicados)
             VALUES (@dispositivo_id, @enviados, @aceptados, @duplicados)`,
            {
              dispositivo_id: dispositivo.id,
              enviados,
              aceptados: resMovimientos.aceptados + resVentas.aceptados,
              duplicados: resMovimientos.duplicados + resVentas.duplicados,
            },
          );
        }
        await db.query(
          'UPDATE DISPOSITIVO SET ultimo_sync = SYSUTCDATETIME() WHERE id = @id',
          { id: dispositivo.id },
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
