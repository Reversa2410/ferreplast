// =============================================================================
// Punto de venta de Ferreplast.
//
// La regla que ordena todo este archivo: LA VENTA EN EFECTIVO NUNCA ESPERA A
// LA RED. Se guarda primero en la cola de la tablet, se le da el ticket al
// cliente, y despues se intenta mandar. Con senial sale en un segundo; sin
// senial se queda en la cola hasta que vuelva. Es un solo camino para los dos
// casos: si hubiera uno "con conexion" y otro "sin conexion", el que se usa
// menos seria el que falla el dia que hace falta.
//
// La unica excepcion es el credito: la API no lo acepta sin conexion (el
// limite se controla contra el saldo de las dos tiendas), asi que va directo
// a POST /ventas y, sin senial, no se puede fiar.
// =============================================================================

import * as L from './logica.js';

// ---- Almacenamiento local --------------------------------------------------
// localStorage y no IndexedDB: los datos son chicos (un catalogo de cientos de
// productos, una cola de ventas del dia) y una API sincrona evita toda una
// clase de errores de "se guardo despues de que se cerro la pestania".
const guardado = {
  leer(clave, porDefecto) {
    try { const v = localStorage.getItem(`fp.${clave}`); return v == null ? porDefecto : JSON.parse(v); }
    catch { return porDefecto; }
  },
  escribir(clave, valor) {
    try { localStorage.setItem(`fp.${clave}`, JSON.stringify(valor)); }
    catch (e) { avisar('No se pudo guardar en la tablet: ' + e.message, true); }
  },
  borrar(clave) { try { localStorage.removeItem(`fp.${clave}`); } catch { /* nada */ } },
};

// ---- Estado ----------------------------------------------------------------
const estado = {
  sesion: guardado.leer('sesion', null),          // { token, expira_en, usuario }
  tienda: guardado.leer('tienda', null),          // { id, nombre, prefijo }
  catalogo: guardado.leer('catalogo', null),      // respuesta de /sync/catalogo
  caja: guardado.leer('caja', null),              // respuesta de /caja/actual
  cola: guardado.leer('cola', []),                // ventas por mandar
  apartadas: guardado.leer('apartadas', []),      // rechazadas por el servidor
  historial: guardado.leer('historial', []),      // ultimas ventas, con su numero
  carrito: [],
  metodo: 'efectivo',
  cliente: null,
  busqueda: '',
  categoria: null,
  enLinea: navigator.onLine,
  sincronizando: false,
  ingreso: { paso: 'tienda', tiendas: [], empleados: [], empleado: null, pin: '', error: '' },
};

const persistir = (...claves) => claves.forEach((c) => guardado.escribir(c, estado[c]));

// ---- Red -------------------------------------------------------------------
class ErrorDeRed extends Error {}

/**
 * Pide a la API. Corta a los 10 segundos: con la senial del pueblo, una
 * peticion puede quedarse colgada indefinidamente, y la pantalla no puede
 * esperar a que el sistema operativo se de por vencido.
 */
async function api(metodo, ruta, cuerpo, { conSesion = true, espera = 10000 } = {}) {
  const corte = new AbortController();
  const reloj = setTimeout(() => corte.abort(), espera);
  let r;
  try {
    r = await fetch(ruta, {
      method: metodo,
      headers: {
        ...(cuerpo !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(conSesion && estado.sesion ? { authorization: `Bearer ${estado.sesion.token}` } : {}),
      },
      body: cuerpo !== undefined ? JSON.stringify(cuerpo) : undefined,
      signal: corte.signal,
    });
  } catch {
    marcarConexion(false);
    throw new ErrorDeRed('sin conexión');
  } finally {
    clearTimeout(reloj);
  }
  marcarConexion(true);
  const datos = await r.json().catch(() => ({}));
  if (r.status === 401 && conSesion) {
    // La sesion vencio o la revocaron. La cola NO se borra: las ventas son
    // del negocio, no de la sesion, y las manda el proximo que entre.
    cerrarSesionLocal('La sesión venció. Vuelva a ingresar con su PIN.');
  }
  return { status: r.status, datos };
}

function marcarConexion(si) {
  if (estado.enLinea === si) return;
  estado.enLinea = si;
  dibujarBarra();
}

// ---- Avisos ----------------------------------------------------------------
let relojAviso;
function avisar(texto, esError = false) {
  const el = document.getElementById('aviso');
  el.textContent = texto;
  el.className = 'aviso' + (esError ? ' error' : '');
  el.hidden = false;
  clearTimeout(relojAviso);
  relojAviso = setTimeout(() => { el.hidden = true; }, esError ? 6000 : 3000);
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const sinTildes = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// =============================================================================
// INGRESO
// =============================================================================
async function cargarTiendas() {
  try {
    const { datos } = await api('GET', '/tiendas', undefined, { conSesion: false });
    estado.ingreso.tiendas = datos.tiendas ?? [];
    guardado.escribir('tiendas', estado.ingreso.tiendas);
  } catch {
    estado.ingreso.tiendas = guardado.leer('tiendas', []);
    estado.ingreso.error = 'Sin conexión. Para entrar hace falta señal: el PIN lo verifica el servidor.';
  }
  dibujar();
}

async function elegirTienda(id) {
  const t = estado.ingreso.tiendas.find((x) => x.id === id);
  estado.tienda = { id: t.id, nombre: t.nombre, prefijo: t.prefijo };
  persistir('tienda');
  try {
    const { datos } = await api('GET', `/auth/empleados/${id}`, undefined, { conSesion: false });
    estado.ingreso.empleados = datos.empleados ?? [];
    estado.ingreso.paso = 'empleado';
    estado.ingreso.error = '';
  } catch {
    estado.ingreso.error = 'Sin conexión: no se puede traer la lista de empleados.';
  }
  dibujar();
}

async function enviarPin() {
  const ing = estado.ingreso;
  try {
    const { status, datos } = await api('POST', '/auth/login/pin',
      { usuario_id: ing.empleado.id, tienda_id: estado.tienda.id, pin: ing.pin }, { conSesion: false });
    if (status !== 200) {
      ing.pin = '';
      ing.error = status === 429 ? (datos.error ?? 'Demasiados intentos. Espere unos minutos.')
        : 'PIN incorrecto.';
      return dibujar();
    }
    estado.sesion = { token: datos.token, expira_en: datos.expira_en, usuario: datos.usuario };
    persistir('sesion');
    estado.ingreso = { paso: 'tienda', tiendas: ing.tiendas, empleados: [], empleado: null, pin: '', error: '' };
    dibujar();
    await Promise.all([refrescarCatalogo(true), refrescarCaja()]);
    pedirAperturaSiHaceFalta();
    sincronizar();
  } catch {
    ing.pin = '';
    ing.error = 'Sin conexión. Intente de nuevo cuando vuelva la señal.';
    dibujar();
  }
}

function cerrarSesionLocal(mensaje) {
  estado.sesion = null;
  guardado.borrar('sesion');
  estado.carrito = [];
  estado.cliente = null;
  cerrarModal();
  estado.ingreso.paso = 'tienda';
  estado.ingreso.error = mensaje ?? '';
  dibujar();
  cargarTiendas();
}

async function salir() {
  if (estado.cola.length && !confirm(`Hay ${estado.cola.length} venta(s) sin enviar. Se van a mandar cuando alguien vuelva a entrar en esta tablet. ¿Salir igual?`)) return;
  try { await api('POST', '/auth/salir'); } catch { /* sin senial: la sesion vence sola */ }
  cerrarSesionLocal();
}

function pantallaIngreso() {
  const ing = estado.ingreso;
  const error = ing.error ? `<div class="error">${esc(ing.error)}</div>` : '';
  if (ing.paso === 'tienda') {
    return `<main class="ingreso">
      <h1>Ferreplast</h1>
      <p class="sub">¿En qué tienda está trabajando hoy?</p>
      ${error}
      <div class="opciones">
        ${ing.tiendas.map((t) => `<button class="opcion" data-accion="tienda" data-id="${t.id}">
          ${esc(t.nombre)}<small>${esc(t.tipo ?? '')}</small></button>`).join('')
          || '<p class="vacio">Cargando tiendas…</p>'}
      </div>
    </main>`;
  }
  if (ing.paso === 'empleado') {
    return `<main class="ingreso">
      <button class="volver" data-accion="volver-tienda">← ${esc(estado.tienda?.nombre)}</button>
      <h1>¿Quién atiende?</h1>
      <p class="sub">Toque su nombre.</p>
      ${error}
      <div class="opciones">
        ${ing.empleados.map((e) => `<button class="opcion" data-accion="empleado" data-id="${e.id}">${esc(e.nombre)}</button>`).join('')
          || '<p class="vacio">No hay empleados asignados a esta tienda.</p>'}
      </div>
    </main>`;
  }
  const puntos = [0, 1, 2, 3].map((i) => `<span class="${i < ing.pin.length ? 'lleno' : ''}"></span>`).join('');
  const teclas = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'borrar', '0', 'ok'];
  return `<main class="ingreso">
    <button class="volver" data-accion="volver-empleado">← Otro empleado</button>
    <h1>${esc(ing.empleado.nombre)}</h1>
    <p class="sub">Escriba su PIN.</p>
    ${error}
    <div class="pin-puntos" aria-label="${ing.pin.length} dígitos escritos">${puntos}</div>
    <div class="teclado">
      ${teclas.map((k) => `<button data-accion="tecla" data-tecla="${k}" aria-label="${k}">${
        k === 'borrar' ? '⌫' : k === 'ok' ? '✓' : k}</button>`).join('')}
    </div>
  </main>`;
}

function tecla(k) {
  const ing = estado.ingreso;
  if (k === 'borrar') ing.pin = ing.pin.slice(0, -1);
  else if (k === 'ok') { if (ing.pin.length >= 4) return enviarPin(); }
  else if (ing.pin.length < 8) ing.pin += k;
  ing.error = '';
  dibujar();
  // Con cuatro digitos se entra solo: es el largo de todos los PIN del negocio.
  if (ing.pin.length === 4 && k !== 'borrar') enviarPin();
}

// =============================================================================
// CATALOGO Y CAJA
// =============================================================================
let ultimoCatalogo = 0;
async function refrescarCatalogo(forzar = false) {
  if (!estado.sesion || !estado.tienda) return;
  // Mientras haya ventas sin mandar, el stock del servidor esta atrasado
  // respecto del de la tablet: traerlo ahora "devolveria" lo ya vendido.
  // Salvo que no haya ningun catalogo: sin el no se puede vender nada.
  if (estado.cola.length && estado.catalogo) return;
  if (!forzar && Date.now() - ultimoCatalogo < 120000) return;
  try {
    const { status, datos } = await api('GET', `/sync/catalogo/${estado.tienda.id}`);
    if (status !== 200) return;
    estado.catalogo = datos;
    ultimoCatalogo = Date.now();
    persistir('catalogo');
    dibujarCatalogo();
  } catch { /* sin senial: se sigue con la copia guardada */ }
}

async function refrescarCaja() {
  if (!estado.sesion) return;
  try {
    const { status, datos } = await api('GET', '/caja/actual');
    if (status !== 200) return;
    estado.caja = datos;
    persistir('caja');
    dibujarBarra();
  } catch { /* se mantiene la ultima conocida */ }
}

/**
 * Al entrar, si la caja esta cerrada, se pide abrirla de una vez. Antes el
 * empleado se enteraba recien al intentar cobrar, con el cliente esperando.
 */
function pedirAperturaSiHaceFalta() {
  if (!estado.sesion || estado.caja?.abierta) return;
  if (!document.getElementById('modal').hidden) return;   // no tapar otra ventana
  abrirCaja('Para empezar a vender, cuente el dinero que hay en el cajón y abra la caja.');
}

/** Descuenta en la copia local lo que se acaba de vender. */
function descontarStockLocal(lineas) {
  if (!estado.catalogo) return;
  for (const l of lineas) {
    const p = estado.catalogo.productos.find((x) => x.id === l.producto_id);
    if (p) p.stock = L.r2(Number(p.stock) - l.cantidad);
  }
  persistir('catalogo');
}

// =============================================================================
// SINCRONIZACION
// =============================================================================
async function sincronizar() {
  if (estado.sincronizando || !estado.sesion || !estado.cola.length) return;
  estado.sincronizando = true;
  dibujarBarra();
  try {
    const lote = estado.cola.slice(0, 500);
    const { status, datos } = await api('POST', '/sync/push', { ventas: lote });
    if (status !== 200) {
      if (status !== 401) avisar(`El servidor no aceptó el envío (${status}). Se reintenta.`, true);
      return;
    }
    const r = L.aplicarRespuestaSync(lote, datos);
    const enviados = new Set(lote.map((v) => v.uuid_externo));
    // Lo que no estaba en el lote (vendido mientras se mandaba) se conserva.
    estado.cola = [...r.quedan, ...estado.cola.filter((v) => !enviados.has(v.uuid_externo))];
    for (const c of r.confirmadas) {
      const h = estado.historial.find((x) => x.uuid === c.uuid_externo);
      if (h) { h.numero = c.numero; h.id = c.id; }
      // Si el ticket de esa venta sigue en pantalla, se le pone el numero
      // definitivo: es el que el cliente tiene que ver en su comprobante.
      const t = document.getElementById('ticket-numero');
      if (t?.dataset.uuid === c.uuid_externo) {
        t.textContent = `${estado.tienda?.prefijo ?? ''}-${c.numero}`;
        document.getElementById('ticket-estado')?.remove();
      }
    }
    if (r.apartadas.length) {
      estado.apartadas.push(...r.apartadas.map((a) => ({ ...a, cuando: new Date().toISOString() })));
      avisar(`${r.apartadas.length} venta(s) rechazada(s) por el servidor. Revise "Rechazadas".`, true);
    }
    persistir('cola', 'apartadas', 'historial');
    if (!estado.cola.length) { refrescarCatalogo(true); refrescarCaja(); }
  } catch { /* sin senial: la cola sigue */ }
  finally {
    estado.sincronizando = false;
    dibujarBarra();
  }
}

async function ciclo() {
  if (!estado.sesion) return;
  try {
    await api('GET', '/salud', undefined, { conSesion: false, espera: 5000 });
  } catch { return; }
  await sincronizar();
  await refrescarCaja();
  await refrescarCatalogo();
}

// =============================================================================
// VENTA
// =============================================================================
function productosVisibles() {
  const ps = estado.catalogo?.productos ?? [];
  const q = sinTildes(estado.busqueda.trim());
  return ps
    .filter((p) => estado.categoria == null || p.categoria_id === estado.categoria)
    .filter((p) => !q || sinTildes(p.nombre).includes(q) || sinTildes(p.codigo).includes(q))
    .slice(0, 120);
}

const productoDe = (id) => estado.catalogo?.productos.find((x) => x.id === id);

/**
 * Pone en el carrito la cantidad pedida de un producto, sin pasarse de lo que
 * hay. Es el unico camino para cambiar una cantidad: tocar la tarjeta, el
 * Enter del lector de codigos y escribir en el campo pasan todos por aca.
 */
function fijarCantidad(producto, pedida) {
  const r = L.limitarAExistencia(pedida, producto.stock, producto.nombre, producto.unidad_medida);
  if (r.aviso) avisar(r.aviso, true);
  const i = estado.carrito.findIndex((it) => it.producto_id === producto.id);
  if (r.cantidad <= 0) {
    if (i >= 0) estado.carrito.splice(i, 1);
  } else if (i >= 0) {
    estado.carrito[i] = { ...estado.carrito[i], cantidad: r.cantidad };
  } else {
    estado.carrito = L.agregar(estado.carrito, producto, r.cantidad);
  }
  return r;
}

function sumarUno(producto) {
  const enCarrito = estado.carrito.find((it) => it.producto_id === producto.id)?.cantidad ?? 0;
  fijarCantidad(producto, L.r2(enCarrito + 1));
  dibujarCarrito();
}

function tarjetaProducto(p) {
  const stock = Number(p.stock);
  const bajo = stock <= Number(p.stock_minimo);
  return `<button class="producto ${stock <= 0 ? 'agotado' : ''}" data-accion="agregar" data-id="${p.id}">
    <span class="nombre">${esc(p.nombre)}</span>
    ${p.codigo ? `<span class="codigo">${esc(p.codigo)}</span>` : ''}
    <span class="precio num">${L.dinero(p.precio_venta)}</span>
    <span class="stock num ${bajo ? 'bajo' : ''}">${stock <= 0 ? 'Sin existencia'
      : `${L.cantidadTexto(stock)} ${esc(p.unidad_medida ?? '')}`}</span>
  </button>`;
}

function htmlCatalogo() {
  const vis = productosVisibles();
  if (!estado.catalogo) return '<p class="vacio">Cargando catálogo…</p>';
  if (!vis.length) return '<p class="vacio">No hay productos que coincidan.</p>';
  return vis.map(tarjetaProducto).join('');
}

function htmlCarrito() {
  if (!estado.carrito.length) {
    return '<p class="vacio">Toque un producto para agregarlo.</p>';
  }
  return estado.carrito.map((it, i) => {
    const l = L.importesLinea(it);
    return `<div class="linea">
      <div class="fila1"><strong>${esc(it.nombre)}</strong><span class="num">${L.dinero(l.subtotal)}</span></div>
      <div class="fila2">
        <label>Cant. <input type="number" inputmode="decimal" min="0" step="any" value="${it.cantidad}"
          data-campo="cantidad" data-i="${i}" aria-label="Cantidad de ${esc(it.nombre)}"></label>
        <span class="num">× ${L.dinero(it.precio_unitario)}</span>
        <label>Rebaja <input type="number" inputmode="decimal" min="0" step="any" value="${it.descuento || ''}"
          placeholder="0" data-campo="descuento" data-i="${i}" aria-label="Rebaja de ${esc(it.nombre)}"></label>
        <button class="quitar" data-accion="quitar" data-i="${i}" aria-label="Quitar ${esc(it.nombre)}">Quitar</button>
      </div>
    </div>`;
  }).join('');
}

function htmlPie() {
  const t = L.totales(estado.carrito);
  const credito = estado.metodo === 'credito';
  return `
    <div class="total-fila"><span>Subtotal</span><span class="num">${L.dinero(t.subtotal)}</span></div>
    ${t.descuento ? `<div class="total-fila"><span>Rebajas</span><span class="num">− ${L.dinero(t.descuento)}</span></div>` : ''}
    <div class="total-fila grande"><span>Total</span><span class="num">${L.dinero(t.total)}</span></div>
    <div class="metodos" role="group" aria-label="Forma de pago">
      <button class="${!credito ? 'activo' : ''}" data-accion="metodo" data-metodo="efectivo">Efectivo</button>
      <button class="${credito ? 'activo' : ''}" data-accion="metodo" data-metodo="credito">Crédito (fiado)</button>
    </div>
    ${credito ? (estado.cliente
      ? `<div class="cliente-elegido"><span><strong>${esc(estado.cliente.nombre)}</strong><br>
           cupo ${L.dinero(estado.cliente.cupo_disponible)}</span>
           <button class="btn btn-chico" data-accion="clientes">Cambiar</button></div>`
      : '<button class="btn" data-accion="clientes">Elegir cliente…</button>')
    : ''}
    <button class="btn btn-exito btn-grande" data-accion="cobrar" ${estado.carrito.length ? '' : 'disabled'}>
      Cobrar ${L.dinero(t.total)}</button>`;
}

/**
 * Ultimo control de existencias antes de cobrar. El carrito ya se limita al
 * agregar, pero el catalogo pudo actualizarse despues (otra venta, una
 * merma cargada en el panel) y dejar una linea por encima de lo que hay.
 */
function revisarExistencias() {
  for (const it of [...estado.carrito]) {
    const p = productoDe(it.producto_id);
    const r = L.limitarAExistencia(it.cantidad, p?.stock ?? 0, it.nombre, p?.unidad_medida);
    if (r.cantidad < it.cantidad) {
      fijarCantidad(p ?? { id: it.producto_id, nombre: it.nombre, stock: 0 }, it.cantidad);
      dibujarCarrito();
      return false;
    }
  }
  return true;
}

async function cobrar() {
  const problemas = L.problemasDelCarrito(estado.carrito);
  if (problemas.length) return avisar(problemas[0], true);
  if (!revisarExistencias()) return;

  if (estado.metodo === 'credito') return cobrarCredito();

  // Efectivo: hace falta una caja abierta para que la plata sume en algun
  // arqueo. Si se sabe que no hay, se frena; si no se sabe (sin senial desde
  // antes de abrir), se pide confirmacion en vez de dejar la tienda parada.
  let cajaId = estado.caja?.abierta ? estado.caja.caja.caja_id : null;
  if (cajaId == null) {
    if (estado.enLinea) {
      await refrescarCaja();
      cajaId = estado.caja?.abierta ? estado.caja.caja.caja_id : null;
    }
    if (cajaId == null) {
      if (estado.enLinea) return abrirCaja('Abra la caja antes de vender en efectivo.');
      // PENDIENTE: abrir caja sin conexion. Hoy POST /caja/apertura exige
      // senial, y una venta sin caja no entra en ningun arqueo. Haria falta
      // que la apertura viaje por la cola como las ventas.
      if (!confirm('No hay una caja abierta y no hay señal para abrirla. La venta se va a guardar, pero no va a sumar en ningún arqueo. ¿Vender igual?')) return;
    }
  }
  pedirPago(cajaId);
}

/**
 * Ventana de cobro en efectivo: cuanto entrega el cliente y cuanto vuelto se
 * le da. No se confirma si lo recibido no alcanza: es el error de mostrador
 * que despues aparece como faltante en el arqueo.
 */
let cajaDelCobro = null;
function pedirPago(cajaId) {
  cajaDelCobro = cajaId;
  const total = L.totales(estado.carrito).total;
  abrirModal(`<h2>Cobrar en efectivo</h2>
    <p class="cobro-total num">${L.dinero(total)}</p>
    <div class="campo"><label for="pago-recibido">¿Con cuánto paga el cliente?</label>
      <input id="pago-recibido" type="number" inputmode="decimal" min="0" step="any"
        data-campo="pago-recibido" class="num" autocomplete="off"></div>
    <div class="billetes" role="group" aria-label="Montos rápidos">
      ${L.sugerenciasDePago(total).map((m) => `<button class="btn" data-accion="paga-con" data-monto="${m}">${
        m === total ? 'Exacto' : L.dinero(m)}</button>`).join('')}
    </div>
    <div class="vuelto" id="pago-vuelto" aria-live="polite"></div>
    <div class="acciones">
      <button class="btn" data-accion="cerrar-modal">Volver</button>
      <button class="btn btn-exito" id="pago-confirmar" data-accion="confirmar-pago" disabled>Confirmar cobro</button>
    </div>`);
  actualizarVuelto();
}

/** Recalcula el vuelto en la ventana de cobro, sin redibujarla. */
function actualizarVuelto() {
  const total = L.totales(estado.carrito).total;
  const campo = document.getElementById('pago-recibido');
  if (!campo) return;
  const recibido = campo.value === '' ? null : Number(campo.value);
  const caja = document.getElementById('pago-vuelto');
  const boton = document.getElementById('pago-confirmar');
  if (recibido == null || !Number.isFinite(recibido)) {
    caja.className = 'vuelto';
    caja.textContent = 'Escriba o toque cuánto le entregó el cliente.';
    boton.disabled = true;
  } else if (L.r2(recibido) < total) {
    caja.className = 'vuelto falta';
    caja.textContent = `Faltan ${L.dinero(L.r2(total - recibido))}.`;
    boton.disabled = true;
  } else {
    caja.className = 'vuelto ok';
    caja.innerHTML = `Vuelto: <strong class="num">${L.dinero(L.r2(recibido - total))}</strong>`;
    boton.disabled = false;
  }
}

function confirmarPago() {
  const campo = document.getElementById('pago-recibido');
  const recibido = Number(campo?.value);
  const total = L.totales(estado.carrito).total;
  if (!(L.r2(recibido) >= total)) return actualizarVuelto();
  const u = estado.sesion.usuario;
  const venta = L.armarVenta({
    carrito: estado.carrito, tienda_id: estado.tienda.id, usuario_id: u.id,
    caja_id: cajaDelCobro, metodo_pago: 'efectivo',
  });
  estado.cola.push(venta);
  registrarEnHistorial(venta, { recibido });
  descontarStockLocal(venta.lineas);
  persistir('cola', 'historial');
  mostrarTicket(venta, { recibido });
  limpiarCarrito();
  sincronizar();
}

/**
 * Guarda la venta en el historial de la tablet CON su detalle. Antes solo se
 * guardaban la hora y el total, y la factura no se podia volver a ver: ni
 * para un reclamo ni para revisar que se cobro. Con el detalle guardado se
 * puede abrir aunque no haya senial o la venta todavia no se haya enviado.
 */
function registrarEnHistorial(venta, { id = null, numero = null, cliente = null, recibido = null } = {}) {
  const porProducto = new Map(estado.carrito.map((it) => [it.producto_id, it]));
  estado.historial.unshift({
    uuid: venta.uuid_externo, id, numero,
    // La tienda va en cada venta: una tablet puede usarse en los dos locales
    // (un empleado entra en uno y otro dia en el otro), y el prefijo de la
    // factura es el del local donde se vendio, no el de donde se mira.
    tienda_id: venta.tienda_id, tienda: estado.tienda?.nombre ?? null, prefijo: estado.tienda?.prefijo ?? '',
    hora: venta.ocurrido_en, metodo: venta.metodo_pago, cliente,
    vendedor: estado.sesion?.usuario?.nombre ?? null,
    subtotal: venta.subtotal, descuento: venta.descuento, total: venta.total, recibido,
    lineas: venta.lineas.map((l) => ({
      producto_id: l.producto_id,
      producto: porProducto.get(l.producto_id)?.nombre ?? productoDe(l.producto_id)?.nombre ?? `#${l.producto_id}`,
      unidad_medida: porProducto.get(l.producto_id)?.unidad ?? '',
      cantidad: l.cantidad, precio_unitario: l.precio_unitario,
      descuento: l.descuento, subtotal: l.subtotal,
    })),
  });
  estado.historial = estado.historial.slice(0, 100);
}

async function cobrarCredito() {
  if (!estado.cliente) return abrirClientes();
  if (!estado.enLinea) return avisar('Fiar necesita señal: el límite se controla contra el saldo de las dos tiendas.', true);
  const venta = L.armarVenta({
    carrito: estado.carrito, tienda_id: estado.tienda.id, usuario_id: estado.sesion.usuario.id,
    metodo_pago: 'credito', cliente_id: estado.cliente.id,
  });
  try {
    // Lleva uuid_externo igual que las de la cola: si la respuesta se pierde y
    // el empleado vuelve a tocar Cobrar, el servidor la reconoce como la misma.
    const { status, datos } = await api('POST', '/ventas', venta);
    if (status === 409 && datos.faltantes?.length) {
      // El servidor sabe algo que la tablet no: otra venta se llevo lo que
      // quedaba. Se corrige la copia local con su numero y se ajusta el
      // carrito, para que el empleado vea al instante cuanto puede vender.
      for (const f of datos.faltantes) {
        const p = productoDe(f.producto_id);
        if (p) { p.stock = f.hay; fijarCantidad(p, f.pedida); }
      }
      persistir('catalogo');
      dibujarCatalogo();
      dibujarCarrito();
      return avisar('No alcanza la existencia: ' + datos.faltantes
        .map((f) => `${f.nombre}, hay ${L.cantidadTexto(f.hay)}`).join('; ') + '. Se ajustó el carrito.', true);
    }
    if (status !== 201 && !(status === 200 && datos.duplicado)) {
      return avisar(datos.error ?? `No se pudo registrar (${status}).`, true);
    }
    descontarStockLocal(venta.lineas);
    registrarEnHistorial(venta, { id: datos.id, numero: datos.numero, cliente: estado.cliente.nombre });
    persistir('historial');
    mostrarTicket(venta, { numero: datos.numero, cliente: estado.cliente.nombre });
    limpiarCarrito();
  } catch {
    avisar('Se cortó la señal. La venta a crédito no se registró: vuelva a intentar.', true);
  }
}

function limpiarCarrito() {
  estado.carrito = [];
  estado.cliente = null;
  estado.metodo = 'efectivo';
  dibujarCarrito();
}

// =============================================================================
// VENTANAS
// =============================================================================
function abrirModal(html) {
  const m = document.getElementById('modal');
  m.innerHTML = `<div class="ventana" role="dialog" aria-modal="true">${html}</div>`;
  m.hidden = false;
  m.querySelector('input')?.focus();
}
function cerrarModal() {
  const m = document.getElementById('modal');
  m.hidden = true;
  m.innerHTML = '';
}

function mostrarTicket(venta, { numero = null, recibido = null, cliente = null } = {}) {
  const pref = estado.tienda?.prefijo ?? '';
  const nombres = new Map(estado.catalogo?.productos.map((p) => [p.id, p.nombre]) ?? []);
  abrirModal(`<div class="ticket">
    <h2>Venta registrada</h2>
    <p class="numero" id="ticket-numero" data-uuid="${venta.uuid_externo}">${numero ? `${esc(pref)}-${numero}` : 'Comprobante provisional'}</p>
    ${numero ? '' : `<p class="tenue" id="ticket-estado">${estado.enLinea ? 'Enviando…' : 'Sin señal: se envía cuando vuelva.'}
      El número lo asigna el servidor.</p>`}
    ${cliente ? `<p>Fiado a <strong>${esc(cliente)}</strong></p>` : ''}
    <table class="tabla-datos">
      ${venta.lineas.map((l) => `<tr><td>${L.cantidadTexto(l.cantidad)} × ${esc(nombres.get(l.producto_id) ?? l.producto_id)}</td>
        <td>${L.dinero(l.subtotal)}</td></tr>`).join('')}
      ${venta.descuento ? `<tr><td>Rebajas</td><td>− ${L.dinero(venta.descuento)}</td></tr>` : ''}
      <tr><td><strong>Total</strong></td><td><strong>${L.dinero(venta.total)}</strong></td></tr>
      ${recibido ? `<tr><td>Recibido</td><td>${L.dinero(recibido)}</td></tr>
        <tr><td><strong>Vuelto</strong></td><td><strong>${L.dinero(L.r2(recibido - venta.total))}</strong></td></tr>` : ''}
    </table>
    <div class="acciones"><button class="btn btn-primario btn-grande" data-accion="cerrar-modal">Nueva venta</button></div>
  </div>`);
}

// ---- Caja --------------------------------------------------------------------
function abrirCaja(motivo) {
  const c = estado.caja;
  if (!c?.abierta) {
    abrirModal(`<h2>Abrir caja</h2>
      ${motivo ? `<p class="nota">${esc(motivo)}</p>` : ''}
      <p class="tenue">Cuente el dinero con que empieza el turno.</p>
      <div class="campo"><label for="monto-inicial">Monto inicial</label>
        <input id="monto-inicial" type="number" inputmode="decimal" min="0" step="any" placeholder="0.00"></div>
      <div class="acciones">
        <button class="btn" data-accion="cerrar-modal">Ahora no</button>
        <button class="btn btn-primario" data-accion="confirmar-apertura" ${estado.enLinea ? '' : 'disabled'}>Abrir caja</button>
      </div>
      ${estado.enLinea ? '' : '<p class="nota">Abrir la caja necesita señal.</p>'}`);
    return;
  }
  const k = c.caja;
  const pendientes = estado.cola.length;
  abrirModal(`<h2>Caja abierta</h2>
    <p class="tenue">Desde ${new Date(k.abierta_en).toLocaleString('es-NI')} · ${esc(k.usuario ?? '')}</p>
    <table class="tabla-datos">
      <tr><td>Monto inicial</td><td>${L.dinero(k.monto_inicial)}</td></tr>
      <tr><td>Ventas en efectivo</td><td>${L.dinero(k.vendido_efectivo)}</td></tr>
      <tr><td>Abonos en efectivo</td><td>${L.dinero(k.abonado_efectivo)}</td></tr>
      <tr><td><strong>Debería haber</strong></td><td><strong>${L.dinero(k.esperado)}</strong></td></tr>
    </table>
    ${pendientes ? `<p class="nota">Hay ${pendientes} venta(s) sin enviar: no están en estas cuentas.
      Para cerrar la caja hay que enviarlas primero.</p>` : ''}
    <div class="campo"><label for="contado">Efectivo contado en el cajón</label>
      <input id="contado" type="number" inputmode="decimal" min="0" step="any" placeholder="0.00"></div>
    <div class="acciones">
      <button class="btn" data-accion="cerrar-modal">Volver</button>
      <button class="btn btn-peligro" data-accion="confirmar-cierre" ${pendientes || !estado.enLinea ? 'disabled' : ''}>Cerrar caja</button>
    </div>`);
}

async function confirmarApertura() {
  // Vacio no es cero: si el empleado no escribio nada, puede que no haya
  // contado. Se pide el numero, aunque sea 0.
  const valor = document.getElementById('monto-inicial').value;
  if (valor === '') return avisar('Escriba con cuánto dinero empieza la caja (0 si está vacía).', true);
  const monto = Number(valor);
  if (!(monto >= 0)) return avisar('El monto inicial no es válido.', true);
  try {
    const { status, datos } = await api('POST', '/caja/apertura', { tienda_id: estado.tienda.id, monto_inicial: monto });
    if (status !== 201) return avisar(datos.error ?? `No se pudo abrir (${status}).`, true);
    await refrescarCaja();
    cerrarModal();
    avisar('Caja abierta.');
  } catch { avisar('Sin señal: no se pudo abrir la caja.', true); }
}

async function confirmarCierre() {
  const valor = document.getElementById('contado').value;
  if (valor === '') return avisar('Escriba cuánto efectivo hay en el cajón.', true);
  const contado = Number(valor);
  if (!(contado >= 0)) return avisar('El monto contado no es válido.', true);
  try {
    const { status, datos } = await api('POST', `/caja/${estado.caja.caja.caja_id}/cierre`, { efectivo_contado: contado });
    if (status !== 200) return avisar(datos.error ?? `No se pudo cerrar (${status}).`, true);
    const texto = { cuadra: 'La caja cuadra.', sobrante: 'Sobra dinero.', faltante: 'Falta dinero.' }[datos.resultado];
    abrirModal(`<h2>Caja cerrada</h2>
      <div class="resultado ${datos.resultado}">${texto}</div>
      <table class="tabla-datos">
        <tr><td>Debería haber</td><td>${L.dinero(datos.esperado)}</td></tr>
        <tr><td>Contado</td><td>${L.dinero(datos.efectivo_contado)}</td></tr>
        <tr><td><strong>Diferencia</strong></td><td><strong>${L.dinero(datos.diferencia)}</strong></td></tr>
      </table>
      <div class="acciones"><button class="btn btn-primario" data-accion="cerrar-modal">Listo</button></div>`);
    await refrescarCaja();
  } catch { avisar('Sin señal: no se pudo cerrar la caja.', true); }
}

// ---- Clientes y abonos ---------------------------------------------------------
let clientesEncontrados = [];
async function abrirClientes() {
  if (!estado.enLinea) return avisar('Los clientes y su saldo se consultan con señal.', true);
  abrirModal(`<h2>Clientes</h2>
    <div class="campo"><input id="buscar-cliente" type="search" placeholder="Buscar por nombre o cédula"
      data-campo="buscar-cliente" aria-label="Buscar cliente"></div>
    <div class="lista-clientes" id="lista-clientes"><p class="vacio">Buscando…</p></div>
    <div class="acciones">
      <button class="btn" data-accion="cerrar-modal">Cerrar</button>
      <button class="btn" data-accion="nuevo-cliente">Cliente nuevo</button>
    </div>`);
  buscarClientes('');
}

let relojBusquedaCliente;
function buscarClientes(q) {
  clearTimeout(relojBusquedaCliente);
  relojBusquedaCliente = setTimeout(async () => {
    try {
      const { datos } = await api('GET', `/clientes${q ? `?q=${encodeURIComponent(q)}` : ''}`);
      clientesEncontrados = datos.clientes ?? [];
      const lista = document.getElementById('lista-clientes');
      if (!lista) return;
      lista.innerHTML = clientesEncontrados.map((c) => `<div class="cliente ${Number(c.cupo_disponible) <= 0 ? 'sin-cupo' : ''}">
        <span><strong>${esc(c.nombre)}</strong><br><span class="tenue">debe ${L.dinero(c.saldo)} · cupo ${L.dinero(c.cupo_disponible)}</span></span>
        <span style="display:flex;gap:6px;align-items:center">
          <button class="btn btn-chico" data-accion="abono" data-id="${c.id}">Abono</button>
          <button class="btn btn-chico btn-primario" data-accion="elegir-cliente" data-id="${c.id}">Fiar</button>
        </span></div>`).join('') || '<p class="vacio">No hay clientes con ese nombre.</p>';
    } catch { /* aviso ya mostrado */ }
  }, 250);
}

function nuevoCliente() {
  abrirModal(`<h2>Cliente nuevo</h2>
    <p class="tenue">Nace con el límite de crédito por omisión. Cambiarlo es del administrador.</p>
    <div class="campo"><label for="cl-nombre">Nombre</label><input id="cl-nombre" autocomplete="off"></div>
    <div class="campo"><label for="cl-tel">Teléfono</label><input id="cl-tel" inputmode="tel" autocomplete="off"></div>
    <div class="campo"><label for="cl-ced">Cédula (opcional)</label><input id="cl-ced" autocomplete="off"></div>
    <div class="acciones">
      <button class="btn" data-accion="clientes">Volver</button>
      <button class="btn btn-primario" data-accion="guardar-cliente">Guardar</button>
    </div>`);
}

async function guardarCliente() {
  const nombre = document.getElementById('cl-nombre').value.trim();
  if (nombre.length < 2) return avisar('Escriba el nombre del cliente.', true);
  const cuerpo = { nombre, telefono: document.getElementById('cl-tel').value.trim() || null,
                   identificacion: document.getElementById('cl-ced').value.trim() || null };
  try {
    const { status, datos } = await api('POST', '/clientes', cuerpo);
    if (status !== 201) return avisar(datos.error ?? `No se pudo guardar (${status}).`, true);
    avisar('Cliente guardado.');
    abrirClientes();
  } catch { avisar('Sin señal: no se guardó el cliente.', true); }
}

function elegirCliente(id) {
  const c = clientesEncontrados.find((x) => x.id === id);
  if (!c) return;
  if (Number(c.cupo_disponible) < L.totales(estado.carrito).total) {
    avisar(`A ${c.nombre} le quedan ${L.dinero(c.cupo_disponible)} de cupo: no alcanza para esta venta.`, true);
  }
  estado.cliente = c;
  estado.metodo = 'credito';
  cerrarModal();
  dibujarCarrito();
}

function abrirAbono(id) {
  const c = clientesEncontrados.find((x) => x.id === id);
  abrirModal(`<h2>Abono de ${esc(c.nombre)}</h2>
    <p class="tenue">Debe ${L.dinero(c.saldo)}. El abono va a su cuenta, no a una factura.</p>
    <div class="campo"><label for="abono-monto">Monto recibido en efectivo</label>
      <input id="abono-monto" type="number" inputmode="decimal" min="0" step="any"></div>
    <div class="acciones">
      <button class="btn" data-accion="clientes">Volver</button>
      <button class="btn btn-primario" data-accion="guardar-abono" data-id="${c.id}">Registrar abono</button>
    </div>`);
}

async function guardarAbono(id) {
  const monto = Number(document.getElementById('abono-monto').value);
  if (!(monto > 0)) return avisar('Escriba el monto del abono.', true);
  try {
    const { status, datos } = await api('POST', `/clientes/${id}/abonos`, { monto, metodo_pago: 'efectivo' });
    if (status !== 201) return avisar(datos.error ?? `No se pudo registrar (${status}).`, true);
    abrirModal(`<h2>Abono registrado</h2>
      <table class="tabla-datos">
        <tr><td>Recibido</td><td>${L.dinero(monto)}</td></tr>
        <tr><td><strong>${datos.saldo_restante < 0 ? 'Saldo a favor' : 'Queda debiendo'}</strong></td>
            <td><strong>${L.dinero(Math.abs(datos.saldo_restante))}</strong></td></tr>
      </table>
      <div class="acciones"><button class="btn btn-primario" data-accion="cerrar-modal">Listo</button></div>`);
    refrescarCaja();
  } catch { avisar('Sin señal: el abono no se registró.', true); }
}

// ---- Ventas del dia y rechazadas ------------------------------------------------
const hora = (iso) => new Date(iso).toLocaleTimeString('es-NI', { hour: '2-digit', minute: '2-digit' });
const fechaHora = (iso) => new Date(iso).toLocaleString('es-NI', {
  day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

/**
 * Ventas de la tienda donde se esta trabajando. Las guardadas antes de que
 * cada venta recordara su tienda no se muestran: no hay forma de saber de
 * cual de los dos locales eran.
 */
const historialDeLaTienda = () => estado.historial.filter((h) => h.tienda_id === estado.tienda?.id);

function abrirHistorial() {
  const pendientes = new Set(estado.cola.map((v) => v.uuid_externo));
  abrirModal(`<h2>Ventas recientes</h2>
    <p class="tenue">Las de esta tienda hechas en esta tablet. Toque una para ver la factura.</p>
    <div class="lista-ventas">
      ${historialDeLaTienda().map((h) => `<button class="fila-venta" data-accion="ver-venta" data-uuid="${h.uuid}">
        <span class="fv-num">${h.numero ? `${esc(h.prefijo)}-${h.numero}`
          : `<span class="chip chip-sin">${pendientes.has(h.uuid) ? 'Sin enviar' : 'Enviando'}</span>`}</span>
        <span class="fv-info">${hora(h.hora)}
          ${h.lineas ? ` · ${h.lineas.length} producto${h.lineas.length === 1 ? '' : 's'}` : ''}
          ${h.metodo === 'credito' ? ` · fiado${h.cliente ? ` a ${esc(h.cliente)}` : ''}` : ''}</span>
        <span class="fv-total num">${L.dinero(h.total)}</span>
        <span class="fv-flecha" aria-hidden="true">›</span>
      </button>`).join('') || '<p class="vacio">Todavía no hay ventas.</p>'}
    </div>
    ${estado.apartadas.length ? `<h2 style="margin-top:20px">Rechazadas por el servidor</h2>
      <p class="tenue">No se reintentan: avise al administrador con este detalle.</p>
      <table class="tabla-datos">${estado.apartadas.map((a) => `<tr>
        <td>${new Date(a.venta.ocurrido_en).toLocaleString('es-NI')} · ${esc(a.motivo)}<br>
          <span class="tenue">${esc(a.detalles ?? '')}</span></td><td>${L.dinero(a.venta.total)}</td></tr>`).join('')}</table>` : ''}
    <div class="acciones">
      ${estado.cola.length && estado.enLinea ? '<button class="btn btn-primario" data-accion="sincronizar">Enviar ahora</button>' : ''}
      <button class="btn" data-accion="cerrar-modal">Cerrar</button>
    </div>`);
}

/**
 * La factura de una venta del historial.
 *
 * Se muestra primero la copia de la tablet (al instante, y sirve sin senial)
 * y, si hay senial, se reemplaza por la del servidor: es la oficial, y puede
 * decir algo que la tablet no sabe, como que el administrador la anulo.
 */
async function abrirFactura(uuid) {
  const h = estado.historial.find((x) => x.uuid === uuid);
  if (!h) return;
  const pendiente = estado.cola.some((v) => v.uuid_externo === uuid);
  if (h.lineas) mostrarFactura(h, { pendiente });
  else abrirModal(`<h2>Factura</h2><p class="tenue" data-factura="${uuid}">Buscando el detalle…</p>
    <div class="acciones"><button class="btn" data-accion="historial">← Ventas</button></div>`);

  if (!estado.enLinea || pendiente) {
    if (!h.lineas) sinDetalle(uuid, 'Sin señal: el detalle de esta venta solo está en el servidor.');
    return;
  }
  try {
    if (!h.id) { if (!h.lineas) sinDetalle(uuid, 'No se encontró esta venta en el servidor.'); return; }
    const { status, datos } = await api('GET', `/ventas/${h.id}`);
    if (status !== 200) { if (!h.lineas) sinDetalle(uuid, datos.error ?? 'No se pudo traer la factura.'); return; }
    // Si el empleado ya cerro o cambio de factura mientras llegaba, no se pisa.
    if (!document.querySelector(`[data-factura="${uuid}"]`)) return;
    const v = datos.venta;
    mostrarFactura({
      uuid, numero: v.numero, prefijo: v.prefijo, tienda: v.tienda, hora: v.ocurrido_en,
      metodo: v.metodo_pago, cliente: v.cliente, vendedor: v.vendedor,
      subtotal: v.subtotal, descuento: v.descuento, total: v.total,
      recibido: h.recibido, anulada: v.anulada, observaciones: v.observaciones,
      lineas: datos.lineas,
    }, { oficial: true });
  } catch { /* sin senial: queda la copia de la tablet */ }
}

function sinDetalle(uuid, mensaje) {
  if (!document.querySelector(`[data-factura="${uuid}"]`)) return;
  abrirModal(`<h2>Factura</h2><p class="nota" data-factura="${uuid}">${esc(mensaje)}</p>
    <div class="acciones"><button class="btn" data-accion="historial">← Ventas</button></div>`);
}

function mostrarFactura(f, { pendiente = false, oficial = false } = {}) {
  const pref = f.prefijo ?? estado.tienda?.prefijo ?? '';
  const metodo = { efectivo: 'Efectivo', credito: 'Crédito (fiado)', tarjeta: 'Tarjeta',
                   transferencia: 'Transferencia', otro: 'Otro' }[f.metodo] ?? f.metodo;
  const vuelto = f.recibido != null && f.metodo === 'efectivo' ? L.r2(f.recibido - f.total) : null;
  abrirModal(`<div class="factura" data-factura="${f.uuid}">
    <div class="factura-cab">
      <div><strong>${esc(f.tienda ?? estado.tienda?.nombre ?? '')}</strong><br>
        <span class="tenue">${fechaHora(f.hora)}</span></div>
      <div class="factura-num">${f.numero ? `${esc(pref)}-${f.numero}`
        : `<span class="chip chip-sin">${pendiente ? 'Sin enviar' : 'Enviando'}</span>`}</div>
    </div>
    ${f.anulada ? `<div class="resultado faltante">ANULADA${f.observaciones ? ` — ${esc(f.observaciones)}` : ''}</div>` : ''}
    <table class="detalle">
      <thead><tr><th>Cant.</th><th>Descripción</th><th>Precio</th><th>Importe</th></tr></thead>
      <tbody>
        ${f.lineas.map((l) => `<tr>
          <td class="num">${L.cantidadTexto(l.cantidad)}${l.unidad_medida && l.unidad_medida !== 'Unidad'
            ? ` <span class="tenue">${esc(l.unidad_medida)}</span>` : ''}</td>
          <td>${esc(l.producto)}${Number(l.descuento) ? `<br><span class="tenue">rebaja − ${L.dinero(l.descuento)}</span>` : ''}</td>
          <td class="num">${L.dinero(l.precio_unitario)}</td>
          <td class="num">${L.dinero(l.subtotal)}</td>
        </tr>`).join('')}
      </tbody>
    </table>
    <table class="tabla-datos">
      ${Number(f.descuento) ? `<tr><td>Subtotal</td><td>${L.dinero(f.subtotal)}</td></tr>
        <tr><td>Rebajas</td><td>− ${L.dinero(f.descuento)}</td></tr>` : ''}
      <tr><td><strong>Total</strong></td><td><strong>${L.dinero(f.total)}</strong></td></tr>
      ${vuelto != null ? `<tr><td>Recibido</td><td>${L.dinero(f.recibido)}</td></tr>
        <tr><td>Vuelto</td><td>${L.dinero(vuelto)}</td></tr>` : ''}
    </table>
    <p class="tenue">${esc(metodo)}${f.cliente ? ` a <strong>${esc(f.cliente)}</strong>` : ''}
      ${f.vendedor ? ` · Atendió ${esc(f.vendedor)}` : ''}
      ${oficial ? '' : ' · copia de la tablet'}</p>
  </div>
  <div class="acciones">
    <button class="btn" data-accion="historial">← Ventas</button>
    <button class="btn" data-accion="imprimir">Imprimir</button>
    <button class="btn btn-primario" data-accion="cerrar-modal">Cerrar</button>
  </div>`);
}

// =============================================================================
// DIBUJO
// =============================================================================
function htmlBarra() {
  const u = estado.sesion?.usuario;
  const cola = estado.cola.length;
  const conexion = estado.sincronizando ? '<span class="chip chip-neutro">Enviando…</span>'
    : estado.enLinea ? '<span class="chip chip-ok">En línea</span>'
    : '<span class="chip chip-sin">Sin señal</span>';
  const caja = estado.caja?.abierta
    ? '<button class="chip chip-ok" data-accion="caja">Caja abierta</button>'
    : '<button class="chip chip-mal" data-accion="caja">Caja cerrada</button>';
  return `<span class="marca">Ferreplast</span>
    <span class="quien">${esc(estado.tienda?.nombre)} · ${esc(u?.nombre)}</span>
    <span class="espacio"></span>
    ${conexion}
    <button class="chip ${cola ? 'chip-sin' : 'chip-neutro'}" data-accion="historial">${
      cola ? `${cola} sin enviar` : 'Ventas'}${estado.apartadas.length ? ` · ${estado.apartadas.length} rechazadas` : ''}</button>
    ${caja}
    <button class="btn btn-chico" data-accion="clientes">Clientes</button>
    <button class="btn btn-chico" data-accion="salir">Salir</button>`;
}

function pantallaVenta() {
  const cats = estado.catalogo?.categorias ?? [];
  return `<header class="barra" id="barra">${htmlBarra()}</header>
  <main class="venta">
    <section class="catalogo" aria-label="Catálogo">
      <input class="buscador" type="search" placeholder="Buscar producto por nombre o código"
        value="${esc(estado.busqueda)}" data-campo="busqueda" aria-label="Buscar producto">
      <div class="categorias" role="group" aria-label="Categorías">
        <button class="${estado.categoria == null ? 'activa' : ''}" data-accion="categoria" data-id="">Todas</button>
        ${cats.map((c) => `<button class="${estado.categoria === c.id ? 'activa' : ''}" data-accion="categoria"
          data-id="${c.id}">${esc(c.nombre)}</button>`).join('')}
      </div>
      <div class="productos" id="productos">${htmlCatalogo()}</div>
    </section>
    <aside class="carrito" aria-label="Venta en curso">
      <h2>Venta</h2>
      <div class="lineas" id="lineas">${htmlCarrito()}</div>
      <div class="pie" id="pie">${htmlPie()}</div>
    </aside>
  </main>`;
}

function dibujar() {
  document.getElementById('app').innerHTML = estado.sesion ? pantallaVenta() : pantallaIngreso();
}
function dibujarBarra() {
  const b = document.getElementById('barra');
  if (b) b.innerHTML = htmlBarra();
}
function dibujarCatalogo() {
  const p = document.getElementById('productos');
  if (p) p.innerHTML = htmlCatalogo();
}
function dibujarCarrito() {
  const l = document.getElementById('lineas');
  const p = document.getElementById('pie');
  if (l) l.innerHTML = htmlCarrito();
  if (p) p.innerHTML = htmlPie();
}
// Solo el pie: redibujar las lineas mientras se escribe en una de ellas le
// quitaria el foco al campo a mitad de la cifra.
function dibujarPie() {
  const p = document.getElementById('pie');
  if (p) p.innerHTML = htmlPie();
}

// =============================================================================
// EVENTOS
// =============================================================================
const acciones = {
  tienda: (d) => elegirTienda(Number(d.id)),
  'volver-tienda': () => { estado.ingreso.paso = 'tienda'; estado.ingreso.error = ''; dibujar(); },
  empleado: (d) => {
    estado.ingreso.empleado = estado.ingreso.empleados.find((e) => e.id === Number(d.id));
    estado.ingreso.paso = 'pin'; estado.ingreso.pin = ''; estado.ingreso.error = '';
    dibujar();
  },
  'volver-empleado': () => { estado.ingreso.paso = 'empleado'; estado.ingreso.error = ''; dibujar(); },
  tecla: (d) => tecla(d.tecla),
  agregar: (d) => sumarUno(productoDe(Number(d.id))),
  quitar: (d) => { estado.carrito.splice(Number(d.i), 1); dibujarCarrito(); },
  categoria: (d) => { estado.categoria = d.id ? Number(d.id) : null; dibujar(); },
  metodo: (d) => {
    estado.metodo = d.metodo;
    if (d.metodo === 'credito' && !estado.cliente) return abrirClientes().then(dibujarCarrito);
    dibujarCarrito();
  },
  cobrar: () => cobrar(),
  'paga-con': (d) => {
    const campo = document.getElementById('pago-recibido');
    campo.value = d.monto;
    actualizarVuelto();
  },
  'confirmar-pago': () => confirmarPago(),
  caja: () => abrirCaja(),
  'confirmar-apertura': () => confirmarApertura(),
  'confirmar-cierre': () => confirmarCierre(),
  clientes: () => abrirClientes(),
  'nuevo-cliente': () => nuevoCliente(),
  'guardar-cliente': () => guardarCliente(),
  'elegir-cliente': (d) => elegirCliente(Number(d.id)),
  abono: (d) => abrirAbono(Number(d.id)),
  'guardar-abono': (d) => guardarAbono(Number(d.id)),
  historial: () => abrirHistorial(),
  'ver-venta': (d) => abrirFactura(d.uuid),
  imprimir: () => window.print(),
  sincronizar: () => sincronizar().then(abrirHistorial),
  'cerrar-modal': () => { cerrarModal(); dibujarCarrito(); },
  salir: () => salir(),
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-accion]');
  if (!el) {
    if (e.target.id === 'modal') cerrarModal();   // toque fuera de la ventana
    return;
  }
  const fn = acciones[el.dataset.accion];
  if (fn) fn(el.dataset);
});

document.addEventListener('input', (e) => {
  const campo = e.target.dataset?.campo;
  if (!campo) return;
  if (campo === 'busqueda') { estado.busqueda = e.target.value; dibujarCatalogo(); return; }
  if (campo === 'pago-recibido') { actualizarVuelto(); return; }
  if (campo === 'buscar-cliente') { buscarClientes(e.target.value.trim()); return; }
  const i = Number(e.target.dataset.i);
  if (!estado.carrito[i]) return;
  let valor = e.target.value === '' ? 0 : Number(e.target.value);
  if (Number.isFinite(valor)) {
    if (campo === 'cantidad') {
      // Se recorta mientras se escribe: si hay 79 y el empleado teclea 80,
      // el campo vuelve a 79 en ese momento, no al cobrar.
      const p = productoDe(estado.carrito[i].producto_id);
      const r = L.limitarAExistencia(valor, p?.stock ?? 0, estado.carrito[i].nombre, p?.unidad_medida);
      if (valor > 0 && r.cantidad < valor) {
        avisar(r.aviso, true);
        valor = r.cantidad;
        e.target.value = valor;
      }
    }
    estado.carrito[i] = { ...estado.carrito[i], [campo]: valor };
    // Se actualiza el importe de la linea en su lugar, sin redibujarla.
    const fila = e.target.closest('.linea')?.querySelector('.fila1 span');
    if (fila) fila.textContent = L.dinero(L.importesLinea(estado.carrito[i]).subtotal);
    dibujarPie();
  }
});


// Enter en el buscador agrega el producto si hay uno solo: con lector de
// codigo de barras (que "escribe" el codigo y Enter) la venta sale sin tocar
// la pantalla.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !document.getElementById('modal').hidden) cerrarModal();
  if (e.key === 'Enter' && e.target.id === 'pago-recibido') { confirmarPago(); return; }
  if (e.key === 'Enter' && e.target.id === 'monto-inicial') { confirmarApertura(); return; }
  if (e.key !== 'Enter' || e.target.dataset?.campo !== 'busqueda') return;
  const vis = productosVisibles();
  const exacto = vis.find((p) => p.codigo && sinTildes(p.codigo) === sinTildes(estado.busqueda.trim()));
  const elegido = exacto ?? (vis.length === 1 ? vis[0] : null);
  if (elegido) {
    estado.busqueda = '';
    e.target.value = '';
    dibujarCatalogo();
    sumarUno(elegido);
  }
});

window.addEventListener('online', () => ciclo());
window.addEventListener('offline', () => marcarConexion(false));

// =============================================================================
// ARRANQUE
// =============================================================================
if ('serviceWorker' in navigator) {
  // Solo existe en https o localhost. En la red local por http no hay service
  // worker: la aplicacion funciona, pero no abre si se recarga sin senial.
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

if (estado.sesion && new Date(estado.sesion.expira_en) < new Date()) {
  estado.sesion = null;
  guardado.borrar('sesion');
}
dibujar();
if (estado.sesion) {
  // Primero la caja (para saber si hay que pedir la apertura), despues el
  // resto del ciclo. Sin senial se usa la ultima caja conocida.
  refrescarCaja().then(pedirAperturaSiHaceFalta);
  ciclo();
  refrescarCatalogo(true);
} else {
  cargarTiendas();
}
setInterval(ciclo, 15000);
