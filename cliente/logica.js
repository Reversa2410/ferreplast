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

/** C$1,234.50 */
const formato = new Intl.NumberFormat('es-NI', { style: 'currency', currency: 'NIO', minimumFractionDigits: 2 });
export const dinero = (n) => formato.format(Number(n) || 0);

/** Cantidades: enteras sin decimales, fraccionarias con hasta 3. */
export const cantidadTexto = (n) => Number(n).toLocaleString('es-NI', { maximumFractionDigits: 3 });
