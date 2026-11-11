// =============================================================================
// Logica del punto de venta que no toca la pantalla.
//
// Vive aparte para poder probarla desde Node (src/test-api.mjs, seccion 29)
// contra los MISMOS esquemas con que el servidor valida. Si la tablet arma una
// venta que el servidor rechaza, el empleado ya le dio el ticket al cliente y
// la venta queda apartada en la cola: es el error mas caro que puede tener
// esta aplicacion, y por eso se prueba con miles de carritos.
// =============================================================================

/** Redondeo a centavos, el mismo que usa el servidor. */
export const r2 = (n) => Math.round(n * 100) / 100;

/**
 * Identificador de la venta generado en la tablet (uuid_externo).
 *
 * crypto.randomUUID solo existe en contextos seguros (https o localhost). En
 * una tablet que entra por la red local con http no esta, y sin esto no se
 * podria vender. getRandomValues si existe en cualquier contexto.
 */
export function nuevoUuid() {
  if (globalThis.crypto?.randomUUID) {
    try { return globalThis.crypto.randomUUID(); } catch { /* contexto no seguro */ }
  }
  const b = globalThis.crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;   // version 4
  b[8] = (b[8] & 0x3f) | 0x80;   // variante RFC 4122
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * Importes de una linea, calculados igual que el servidor los comprueba:
 * bruto = cantidad x precio redondeado; subtotal = bruto - rebaja, redondeado.
 */
export function importesLinea({ cantidad, precio_unitario, descuento = 0 }) {
  const bruto = r2(cantidad * precio_unitario);
  const rebaja = r2(descuento);
  return { bruto, descuento: rebaja, subtotal: r2(bruto - rebaja) };
}

/** Totales del carrito: lo que se muestra y lo que se manda. */
export function totales(carrito) {
  let subtotal = 0, descuento = 0;
  for (const it of carrito) {
    const l = importesLinea(it);
    subtotal = r2(subtotal + l.bruto);
    descuento = r2(descuento + l.descuento);
  }
  return { subtotal, descuento, total: r2(subtotal - descuento) };
}

/**
 * Problemas del carrito que el empleado tiene que arreglar antes de cobrar.
 * Devuelve una lista de mensajes; vacia si se puede cobrar.
 */
export function problemasDelCarrito(carrito) {
  const p = [];
  if (!carrito.length) p.push('El carrito está vacío.');
  for (const it of carrito) {
    if (!(it.cantidad > 0)) p.push(`${it.nombre}: la cantidad tiene que ser mayor que cero.`);
    if (!(it.descuento >= 0)) p.push(`${it.nombre}: la rebaja no puede ser negativa.`);
    else if (r2(it.descuento) > r2(it.cantidad * it.precio_unitario)) {
      p.push(`${it.nombre}: la rebaja supera el importe de la línea.`);
    }
  }
  return p;
}

/**
 * Arma la venta tal como la esperan /sync/push y /ventas.
 *
 * ocurrido_en se manda con la hora de la tablet: una venta sin conexion pudo
 * pasar hace horas, y la hora del servidor al sincronizar seria falsa.
 */
export function armarVenta({ carrito, tienda_id, usuario_id, caja_id = null, metodo_pago = 'efectivo',
                             cliente_id = null, uuid = nuevoUuid(), ahora = new Date() }) {
  const t = totales(carrito);
  return {
    uuid_externo: uuid,
    ocurrido_en: ahora.toISOString(),
    tienda_id,
    usuario_id,
    caja_id,
    cliente_id,
    metodo_pago,
    subtotal: t.subtotal,
    descuento: t.descuento,
    total: t.total,
    lineas: carrito.map((it) => {
      const l = importesLinea(it);
      return {
        producto_id: it.producto_id,
        cantidad: it.cantidad,
        precio_unitario: it.precio_unitario,
        costo_unitario: it.costo_unitario ?? 0,
        descuento: l.descuento,
        subtotal: l.subtotal,
      };
    }),
  };
}

/**
 * Agrega un producto al carrito. Si ya estaba, suma la cantidad: el servidor
 * no admite el mismo producto en dos lineas (se le pediria al empleado que
 * las junte a mano).
 */
export function agregar(carrito, producto, cantidad = 1) {
  const i = carrito.findIndex((it) => it.producto_id === producto.id);
  if (i >= 0) {
    return carrito.map((it, k) => (k === i ? { ...it, cantidad: r2(it.cantidad + cantidad) } : it));
  }
  return [...carrito, {
    producto_id: producto.id,
    nombre: producto.nombre,
    unidad: producto.unidad_medida,
    cantidad,
    precio_unitario: Number(producto.precio_venta),
    costo_unitario: Number(producto.precio_costo ?? 0),
    descuento: 0,
  }];
}

/**
 * Limita una cantidad a lo que hay en existencia.
 *
 * Devuelve la cantidad que se puede vender y, si hubo que recortarla, el
 * mensaje para el empleado. Sin esto se podia vender 80 de un producto del que
 * habia 79, y el stock quedaba en negativo: el sistema decia que habia menos
 * que nada.
 *
 * La existencia es la de la copia de la tablet, que ya descuenta lo vendido y
 * todavia no enviado.
 */
export function limitarAExistencia(pedida, existencia, nombre = 'el producto', unidad = '') {
  const hay = Math.max(0, r2(Number(existencia) || 0));
  if (hay <= 0) {
    return { cantidad: 0, aviso: `${nombre} no tiene existencia en esta tienda.` };
  }
  if (pedida > hay) {
    return { cantidad: hay,
             aviso: `Solo hay ${cantidadTexto(hay)}${unidad ? ` ${unidad}` : ''} de ${nombre}. Se ajustó la cantidad.` };
  }
  return { cantidad: pedida, aviso: null };
}

/**
 * Billetes sugeridos para cobrar: el monto exacto y los redondeos hacia arriba
 * con los billetes de cordoba mas comunes. Es lo que el cliente suele entregar,
 * y tocarlo es mas rapido que escribirlo.
 */
export function sugerenciasDePago(total) {
  const opciones = new Set([r2(total)]);
  // Sin el de 10 ni el de 200: con ellos las sugerencias quedan pegadas
  // (210, 220, 250, 300) y no aparece el billete de 500, que es justo con el
  // que se suele pagar una compra de doscientos y pico.
  for (const billete of [20, 50, 100, 500, 1000]) {
    const v = Math.ceil(total / billete) * billete;
    if (v > total) opciones.add(v);
  }
  return [...opciones].sort((a, b) => a - b).slice(0, 5);
}

/**
 * Aplica la respuesta de /sync/push a la cola.
 *
 * - aceptados y duplicados salen de la cola (un duplicado es un envio
 *   anterior que si llego);
 * - los rechazados salen de la cola y pasan a "apartadas": reintentarlos
 *   daria el mismo rechazo para siempre y taparia a los de atras;
 * - los asignados traen el numero de comprobante que puso el servidor.
 *
 * Lo que no aparece en ninguna lista se queda en la cola para el proximo
 * intento.
 */
export function aplicarRespuestaSync(enviadas, respuesta) {
  const v = respuesta?.ventas ?? {};
  const rechazos = new Map((v.rechazados ?? []).map((r) => [r.uuid_externo, r]));
  const asignados = new Map((v.asignados ?? []).map((a) => [a.uuid_externo, a]));
  const confirmadas = [], apartadas = [], quedan = [];
  for (const venta of enviadas) {
    const rechazo = rechazos.get(venta.uuid_externo);
    const asignado = asignados.get(venta.uuid_externo);
    if (rechazo) apartadas.push({ venta, motivo: rechazo.motivo, detalles: rechazo.detalles });
    else if (asignado) confirmadas.push({ uuid_externo: venta.uuid_externo, id: asignado.id, numero: asignado.numero });
    else quedan.push(venta);
  }
  return { confirmadas, apartadas, quedan };
}

// =============================================================================
// Entradas de mercaderia
// =============================================================================

/** Lo que el empleado tiene que corregir antes de registrar una entrada. */
export function problemasDeEntrada(lineas) {
  const p = [];
  if (!lineas.length) p.push('Agregue al menos un producto.');
  for (const l of lineas) {
    if (!(l.cantidad > 0)) p.push(`${l.nombre}: la cantidad tiene que ser mayor que cero.`);
    if (l.costo_unitario == null || !(l.costo_unitario >= 0)) {
      p.push(`${l.nombre}: el costo no puede quedar vacío ni ser negativo.`);
    }
  }
  return p;
}

/**
 * Arma los movimientos de una entrada tal como los espera /sync/push: uno por
 * producto, todos con el mismo motivo (proveedor o factura) y la misma hora.
 *
 * Cada uno lleva su uuid_externo: es lo que hace que reenviar la entrada,
 * cuando la respuesta se perdio, no sume la mercaderia dos veces.
 */
export function armarEntrada({ lineas, tienda_id, usuario_id, motivo = null, ahora = new Date() }) {
  const texto = (motivo ?? '').trim();
  return lineas.map((l) => ({
    uuid_externo: nuevoUuid(),
    tienda_id,
    producto_id: l.producto_id,
    usuario_id,
    tipo: 'entrada',
    cantidad: l.cantidad,
    costo_unitario: r2(l.costo_unitario),
    motivo: texto ? texto.slice(0, 255) : null,
    ocurrido_en: ahora.toISOString(),
  }));
}

/**
 * Aplica la respuesta de /sync/push a la cola de movimientos.
 *
 * A diferencia de las ventas, los movimientos no vuelven en "asignados" (no
 * tienen numero que conciliar). No hace falta: con una respuesta 200 el
 * servidor proceso TODOS los elementos, asi que lo que no esta en rechazados
 * entro o ya estaba. Los rechazados se apartan, como las ventas.
 */
export function aplicarRespuestaMovimientos(enviados, respuesta) {
  const rechazos = new Map((respuesta?.movimientos?.rechazados ?? []).map((r) => [r.uuid_externo, r]));
  const confirmados = [], apartados = [];
  for (const m of enviados) {
    const r = rechazos.get(m.uuid_externo);
    if (r) apartados.push({ movimiento: m, motivo: r.motivo, detalles: r.detalles });
    else confirmados.push(m.uuid_externo);
  }
  return { confirmados, apartados };
}

/** C$1,234.50 */
const formato = new Intl.NumberFormat('es-NI', { style: 'currency', currency: 'NIO', minimumFractionDigits: 2 });
export const dinero = (n) => formato.format(Number(n) || 0);

/** Cantidades: enteras sin decimales, fraccionarias con hasta 3. */
export const cantidadTexto = (n) => Number(n).toLocaleString('es-NI', { maximumFractionDigits: 3 });

// =============================================================================
// Panel del duenio
// =============================================================================

/** C$15.8 mil -- para las etiquetas de la grafica, donde no entra la cifra entera. */
export function dineroCorto(n) {
  const v = Math.abs(Number(n) || 0);
  const signo = Number(n) < 0 ? '−' : '';
  if (v < 1000) return `${signo}C$${Math.round(v)}`;
  if (v < 1e6) return `${signo}C$${(v / 1000).toFixed(1).replace(/\.0$/, '')} mil`;
  return `${signo}C$${(v / 1e6).toFixed(1).replace(/\.0$/, '')} M`;
}

/** Porcentaje entero, o null si no hay base (sin ventas no hay margen, no hay "0%"). */
export function porcentaje(parte, total) {
  const t = Number(total);
  if (!t) return null;
  return Math.round((Number(parte) / t) * 100);
}

/**
 * Las columnas DATE vuelven como "2026-11-10T00:00:00.000Z": medianoche UTC
 * del dia del calendario. Se recorta el texto en lugar de pasarlo por Date en
 * la zona del navegador, que lo moveria al dia anterior en Nicaragua (UTC-6).
 */
export const diaDe = (fecha) => String(fecha).slice(0, 10);

/** '2026-11-10' + n dias, sin pasar por la zona horaria del navegador. */
export function sumarDias(fecha, n) {
  const [a, m, d] = diaDe(fecha).split('-').map(Number);
  return new Date(Date.UTC(a, m - 1, d + n)).toISOString().slice(0, 10);
}

const enUtc = (fecha) => { const [a, m, d] = diaDe(fecha).split('-').map(Number); return new Date(Date.UTC(a, m - 1, d)); };
export const fechaCorta = (fecha) => enUtc(fecha).toLocaleDateString('es-NI', { timeZone: 'UTC', day: 'numeric', month: 'short' });
export const fechaLarga = (fecha) => enUtc(fecha).toLocaleDateString('es-NI',
  { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
export const diaSemana = (fecha) => enUtc(fecha).toLocaleDateString('es-NI', { timeZone: 'UTC', weekday: 'short' });

/**
 * Fecha y hora de un instante guardado en UTC, en la hora de las tiendas.
 * Con zona fija y no la del navegador: si la duenia mira el panel desde otro
 * pais, la venta de las 6 de la tarde sigue siendo de las 6 de la tarde.
 */
export const fechaHora = (iso) => new Date(iso).toLocaleString('es-NI', {
  timeZone: 'America/Managua', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
export const hora = (iso) => new Date(iso).toLocaleTimeString('es-NI', {
  timeZone: 'America/Managua', hour: '2-digit', minute: '2-digit' });

/**
 * Serie diaria de las dos tiendas sumadas, con los dias sin ventas en cero.
 * Sin rellenar, un dia sin ventas desapareceria de la grafica y el anterior
 * quedaria pegado al siguiente como si fueran consecutivos.
 */
export function serieDiaria(filas, desde, hasta) {
  const porDia = new Map();
  for (const f of filas) {
    const d = diaDe(f.fecha);
    porDia.set(d, r2((porDia.get(d) ?? 0) + Number(f.total_vendido)));
  }
  const dias = [];
  for (let d = diaDe(desde); d <= diaDe(hasta); d = sumarDias(d, 1)) {
    dias.push({ fecha: d, total: porDia.get(d) ?? 0 });
  }
  return dias;
}

const sinTildes = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Filtro del inventario: busqueda por nombre o codigo, y "para reponer" o "en negativo". */
export function filtrarInventario(filas, { buscar = '', solo = 'todos' } = {}) {
  const q = sinTildes(buscar.trim());
  return filas
    .filter((p) => solo !== 'reponer' || p.necesita_reposicion)
    .filter((p) => solo !== 'negativo' || Number(p.cantidad) < 0)
    .filter((p) => !q || sinTildes(p.producto).includes(q) || sinTildes(p.codigo).includes(q));
}

/**
 * Como le fue a una caja, en palabras. La diferencia que se mira es la REAL
 * (la que sale hoy de las ventas no anuladas), no la que se guardo al cerrar.
 */
export function resultadoCaja(c) {
  if (c.estado === 'abierta' || c.diferencia_real == null) return { clase: '', texto: 'Abierta' };
  const dif = r2(Number(c.diferencia_real));
  if (dif === 0) return { clase: 'bien', texto: 'Cuadra' };
  if (dif > 0) return { clase: 'aviso', texto: `Sobran ${dinero(dif)}` };
  return { clase: 'mal', texto: `Faltan ${dinero(-dif)}` };
}

/** Hace cuanto envio sus ventas una tablet, y si hay que preocuparse. */
export function estadoSincronizacion(minutos) {
  if (minutos == null) return { clase: 'mal', texto: 'Nunca envió' };
  const m = Number(minutos);
  if (m <= 15) return { clase: 'bien', texto: 'Al día' };
  const cuanto = m < 120 ? `${m} min` : m < 2880 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} días`;
  return { clase: m <= 120 ? 'aviso' : 'mal', texto: `Hace ${cuanto} sin enviar` };
}
