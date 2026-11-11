// =============================================================================
// Panel del duenio de Ferreplast.
//
// Muestra las dos tiendas juntas: lo que hoy obliga a caminar hasta la otra
// esquina o a llamar por telefono. Todo sale de los reportes de la API, que a
// su vez salen de las vistas v_* de la base: este archivo no calcula ventas,
// ganancias ni saldos. Si un numero del panel no coincide con el de SSMS, el
// error esta en la vista, no aca.
//
// No trabaja sin conexion, a proposito: un panel que muestra numeros viejos
// como si fueran de ahora es peor que uno que dice "sin conexion".
// =============================================================================

import * as L from './logica.js';

const CLAVE_SESION = 'fp.panel.sesion';   // distinta de la de la tablet
const VISTAS = ['resumen', 'ventas', 'inventario', 'cobrar', 'cajas', 'tablets'];
const NOMBRES = {
  resumen: 'Resumen', ventas: 'Ventas', inventario: 'Inventario',
  cobrar: 'Por cobrar', cajas: 'Cajas', tablets: 'Tablets',
};

const est = {
  sesion: leerSesion(),
  tiendas: [],
  hoy: null,                 // el dia del negocio, segun el servidor
  vista: 'resumen',
  // Filtros de cada vista: se conservan al ir y volver entre secciones.
  filtros: {
    resumen: { fecha: '' },
    ventas: { desde: '', hasta: '', tienda: '', metodo: '', pagina: 1 },
    inventario: { tienda: '', buscar: '', solo: 'todos' },
    cobrar: { todos: false },
    cajas: { tienda: '', estado: '' },
  },
  datos: {},
};

function leerSesion() {
  try { return JSON.parse(localStorage.getItem(CLAVE_SESION)); } catch { return null; }
}
function guardarSesion(s) {
  try {
    if (s) localStorage.setItem(CLAVE_SESION, JSON.stringify(s));
    else localStorage.removeItem(CLAVE_SESION);
  } catch { /* sin almacenamiento: la sesion dura lo que la pestania */ }
}

// ---- Red ---------------------------------------------------------------------
class ErrorDeRed extends Error {}

async function api(metodo, ruta, cuerpo, { conSesion = true } = {}) {
  const corte = new AbortController();
  const reloj = setTimeout(() => corte.abort(), 15000);
  let r;
  try {
    r = await fetch(ruta, {
      method: metodo,
      headers: {
        ...(cuerpo !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(conSesion && est.sesion ? { authorization: `Bearer ${est.sesion.token}` } : {}),
      },
      body: cuerpo !== undefined ? JSON.stringify(cuerpo) : undefined,
      signal: corte.signal,
    });
  } catch {
    throw new ErrorDeRed('Sin conexión con el servidor.');
  } finally {
    clearTimeout(reloj);
  }
  const datos = await r.json().catch(() => ({}));
  if (r.status === 401 && conSesion) {
    salirLocal('La sesión venció. Vuelva a ingresar.');
    throw new ErrorDeRed('sesión vencida');
  }
  if (r.status === 403 && conSesion) {
    // Un empleado que entro con su correo no tiene que ver el panel; la API
    // ya lo frena, aca solo se explica.
    throw new Error('Esta sección es solo del administrador.');
  }
  return { status: r.status, datos };
}

/** Pide y devuelve los datos, o lanza un error con mensaje para mostrar. */
async function traer(ruta) {
  const { status, datos } = await api('GET', ruta);
  if (status !== 200) throw new Error(datos.error ?? `El servidor respondió ${status}.`);
  return datos;
}

// ---- Utilidades de pantalla -------------------------------------------------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let relojAviso;
function avisar(texto, esError = false) {
  const el = document.getElementById('aviso');
  el.textContent = texto;
  el.className = 'aviso' + (esError ? ' error' : '');
  el.hidden = false;
  clearTimeout(relojAviso);
  relojAviso = setTimeout(() => { el.hidden = true; }, esError ? 6000 : 3000);
}

function abrirModal(html) {
  const m = document.getElementById('modal');
  m.innerHTML = `<div class="ventana ventana-ancha" role="dialog" aria-modal="true">${html}</div>`;
  m.hidden = false;
  m.querySelector('input, textarea')?.focus();
}
function cerrarModal() {
  const m = document.getElementById('modal');
  m.hidden = true;
  m.innerHTML = '';
}

const prefijoDe = (tiendaId) => est.tiendas.find((t) => t.id === tiendaId)?.prefijo ?? '';
const opcionesTienda = (elegida) => `<option value="">Las dos tiendas</option>${est.tiendas.map((t) =>
  `<option value="${t.id}" ${String(t.id) === String(elegida) ? 'selected' : ''}>${esc(t.nombre)}</option>`).join('')}`;

const METODOS = { efectivo: 'Efectivo', credito: 'Crédito', tarjeta: 'Tarjeta',
                  transferencia: 'Transferencia', otro: 'Otro' };

// =============================================================================
// INGRESO
// =============================================================================
function pantallaIngreso(error = '', correo = '') {
  document.getElementById('app').innerHTML = `<main class="ingreso">
    <h1>Panel del dueño</h1>
    <p class="sub">Ferreplast · las dos tiendas</p>
    ${error ? `<div class="error">${esc(error)}</div>` : ''}
    <form id="form-ingreso" class="tarjeta-form">
      <div class="campo"><label for="correo">Correo</label>
        <input id="correo" type="email" autocomplete="username" required value="${esc(correo)}"></div>
      <div class="campo"><label for="clave">Contraseña</label>
        <input id="clave" type="password" autocomplete="current-password" required></div>
      <button class="btn btn-primario btn-grande" type="submit">Entrar</button>
    </form>
    <p class="tenue">¿Es empleado? El punto de venta está en <a href="./">la pantalla de venta</a>.</p>
  </main>`;
  // Con el correo ya escrito (tras una clave equivocada) se va directo a la clave.
  document.getElementById(correo ? 'clave' : 'correo').focus();
}

async function ingresar(e) {
  e.preventDefault();
  const email = document.getElementById('correo').value.trim();
  const password = document.getElementById('clave').value;
  try {
    const { status, datos } = await api('POST', '/auth/login/admin', { email, password }, { conSesion: false });
    if (status !== 200) {
      return pantallaIngreso(status === 429 ? (datos.error ?? 'Demasiados intentos. Espere unos minutos.')
        : 'Correo o contraseña incorrectos.', email);
    }
    est.sesion = { token: datos.token, expira_en: datos.expira_en, usuario: datos.usuario };
    guardarSesion(est.sesion);
    await arrancar();
  } catch (err) {
    pantallaIngreso(err.message);
  }
}

function salirLocal(mensaje) {
  est.sesion = null;
  guardarSesion(null);
  cerrarModal();
  pantallaIngreso(mensaje);
}

async function salir() {
  try { await api('POST', '/auth/salir'); } catch { /* la sesion vence sola */ }
  salirLocal();
}

// =============================================================================
// ESTRUCTURA
// =============================================================================
function dibujarMarco() {
  const u = est.sesion.usuario;
  document.getElementById('app').innerHTML = `
    <header class="barra">
      <span class="marca">Ferreplast</span>
      <span class="quien">Panel del dueño · ${esc(u.nombre)}</span>
      <span class="espacio"></span>
      <button class="btn btn-chico" data-accion="actualizar">Actualizar</button>
      <button class="btn btn-chico" data-accion="salir">Salir</button>
    </header>
    <nav class="pestanias" aria-label="Secciones">
      ${VISTAS.map((v) => `<a href="#${v}" class="${est.vista === v ? 'activa' : ''}">${NOMBRES[v]}</a>`).join('')}
    </nav>
    <main class="contenido" id="contenido"></main>`;
}

function marcarPestania() {
  document.querySelectorAll('.pestanias a').forEach((a) => {
    a.classList.toggle('activa', a.getAttribute('href') === `#${est.vista}`);
  });
}

const contenido = () => document.getElementById('contenido');

async function mostrarVista() {
  const v = location.hash.slice(1);
  est.vista = VISTAS.includes(v) ? v : 'resumen';
  marcarPestania();
  contenido().innerHTML = '<p class="vacio">Cargando…</p>';
  try {
    await { resumen: vistaResumen, ventas: vistaVentas, inventario: vistaInventario,
            cobrar: vistaCobrar, cajas: vistaCajas, tablets: vistaTablets }[est.vista]();
  } catch (err) {
    if (err instanceof ErrorDeRed && !est.sesion) return;
    contenido().innerHTML = `<div class="error">No se pudo cargar: ${esc(err.message)}</div>
      <button class="btn" data-accion="actualizar">Reintentar</button>`;
  }
}

// =============================================================================
// RESUMEN
// =============================================================================
async function vistaResumen() {
  const f = est.filtros.resumen;
  const r = await traer(`/reportes/resumen${f.fecha ? `?fecha=${f.fecha}` : ''}`);
  if (!f.fecha) est.hoy = r.fecha;
  // Serie de los ultimos 14 dias hasta el dia elegido, para ver la tendencia.
  const hasta = r.fecha;
  const desde = L.sumarDias(hasta, -13);
  const serie = await traer(`/reportes/ventas?desde=${desde}&hasta=${hasta}`);

  const c = r.consolidado;
  const margen = L.porcentaje(c.ganancia_bruta, c.total_vendido);
  const maxTienda = Math.max(1, ...r.por_tienda.map((t) => Number(t.total_vendido)));
  const valorizado = new Map(r.inventario_valorizado.map((i) => [i.tienda, i]));
  const dias = L.serieDiaria(serie.ventas, desde, hasta);
  const maxDia = Math.max(1, ...dias.map((d) => d.total));

  contenido().innerHTML = `
    <div class="encabezado-vista">
      <h1>${f.fecha && f.fecha !== est.hoy ? `Resumen del ${L.fechaCorta(r.fecha)}` : 'Hoy'}
        <span class="tenue">${L.fechaLarga(r.fecha)}</span></h1>
      <label class="filtro">Día <input type="date" value="${r.fecha}" max="${est.hoy ?? ''}" data-filtro="resumen.fecha"></label>
    </div>

    <section class="indicadores">
      <div class="indicador"><span>Vendido</span><strong class="num">${L.dinero(c.total_vendido)}</strong>
        <small>${r.por_tienda.reduce((a, t) => a + t.cantidad_ventas, 0)} ventas</small></div>
      <div class="indicador"><span>Ganancia</span><strong class="num">${L.dinero(c.ganancia_bruta)}</strong>
        <small>${margen == null ? 'sin ventas' : `margen ${margen}%`}</small></div>
      <a class="indicador" href="#cobrar"><span>Por cobrar</span><strong class="num">${L.dinero(c.por_cobrar)}</strong>
        <small>${c.clientes_con_deuda} cliente${c.clientes_con_deuda === 1 ? '' : 's'} con deuda</small></a>
      <a class="indicador ${c.cantidad_alertas ? 'alerta' : ''}" href="#inventario" data-accion="ver-reposicion">
        <span>Para reponer</span><strong class="num">${c.cantidad_alertas}</strong>
        <small>productos bajo el mínimo</small></a>
    </section>

    <section class="bloque">
      <h2>Por tienda</h2>
      <table class="tabla">
        <thead><tr><th>Tienda</th><th class="d">Ventas</th><th class="d">Vendido</th><th></th>
          <th class="d">Costo</th><th class="d">Ganancia</th><th class="d">Margen</th><th class="d">Ticket prom.</th>
          <th class="d">Inventario a costo</th></tr></thead>
        <tbody>
          ${est.tiendas.map((t) => {
            const d = r.por_tienda.find((x) => x.tienda_id === t.id);
            const inv = valorizado.get(t.nombre);
            const vendido = Number(d?.total_vendido ?? 0);
            return `<tr>
              <td><strong>${esc(t.nombre)}</strong></td>
              <td class="d num">${d?.cantidad_ventas ?? 0}</td>
              <td class="d num">${L.dinero(vendido)}</td>
              <td class="barra-celda"><span class="barrita" style="width:${(vendido / maxTienda) * 100}%"></span></td>
              <td class="d num">${L.dinero(d?.costo_mercaderia ?? 0)}</td>
              <td class="d num">${L.dinero(d?.ganancia_bruta ?? 0)}</td>
              <td class="d num">${d ? `${L.porcentaje(d.ganancia_bruta, d.total_vendido) ?? 0}%` : '—'}</td>
              <td class="d num">${d ? L.dinero(d.ticket_promedio) : '—'}</td>
              <td class="d num">${inv ? L.dinero(inv.valor_costo) : '—'}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </section>

    <section class="bloque">
      <h2>Últimos 14 días <span class="tenue">· vendido por día, las dos tiendas</span></h2>
      <div class="serie" role="img" aria-label="Ventas de los últimos 14 días">
        ${dias.map((d) => `<div class="dia ${d.fecha === r.fecha ? 'elegido' : ''}" title="${L.fechaCorta(d.fecha)}: ${L.dinero(d.total)}">
          <span class="valor num">${d.total ? L.dineroCorto(d.total) : ''}</span>
          <span class="columna" style="height:${(d.total / maxDia) * 100}%"></span>
          <span class="etiqueta">${L.diaSemana(d.fecha)}<br>${Number(d.fecha.slice(8))}</span>
        </div>`).join('')}
      </div>
    </section>

    <section class="bloque">
      <h2>Para reponer <span class="tenue">· en o bajo el mínimo</span></h2>
      ${r.alertas_stock.length ? `<table class="tabla">
        <thead><tr><th>Tienda</th><th>Código</th><th>Producto</th><th class="d">Hay</th><th class="d">Mínimo</th></tr></thead>
        <tbody>${r.alertas_stock.slice(0, 12).map((a) => `<tr class="${Number(a.cantidad) < 0 ? 'negativo' : ''}">
          <td>${esc(a.tienda)}</td><td class="tenue">${esc(a.codigo ?? '')}</td><td>${esc(a.producto)}</td>
          <td class="d num">${L.cantidadTexto(a.cantidad)} ${esc(a.unidad_medida ?? '')}</td>
          <td class="d num">${L.cantidadTexto(a.cantidad_minima)}</td></tr>`).join('')}</tbody>
      </table>
      ${r.alertas_stock.length > 12 ? `<p><a href="#inventario" data-accion="ver-reposicion">Ver los ${r.alertas_stock.length}…</a></p>` : ''}`
      : '<p class="vacio">Nada para reponer.</p>'}
    </section>`;
}

// =============================================================================
// VENTAS
// =============================================================================
async function vistaVentas() {
  const f = est.filtros.ventas;
  if (!f.hasta) f.hasta = est.hoy ?? '';
  if (!f.desde && f.hasta) f.desde = L.sumarDias(f.hasta, -6);
  const q = new URLSearchParams();
  if (f.desde) q.set('desde', f.desde);
  if (f.hasta) q.set('hasta', f.hasta);
  if (f.tienda) q.set('tienda_id', f.tienda);
  if (f.metodo) q.set('metodo_pago', f.metodo);
  q.set('pagina', f.pagina);

  const qr = new URLSearchParams(q); qr.delete('metodo_pago'); qr.delete('pagina');
  const [lista, porDia] = await Promise.all([traer(`/ventas?${q}`), traer(`/reportes/ventas?${qr}`)]);
  const tot = porDia.ventas.reduce((a, d) => ({
    ventas: a.ventas + d.cantidad_ventas, vendido: a.vendido + Number(d.total_vendido),
    ganancia: a.ganancia + Number(d.ganancia_bruta) }), { ventas: 0, vendido: 0, ganancia: 0 });

  contenido().innerHTML = `
    <div class="encabezado-vista"><h1>Ventas</h1></div>
    <div class="filtros">
      <label class="filtro">Desde <input type="date" value="${f.desde}" data-filtro="ventas.desde"></label>
      <label class="filtro">Hasta <input type="date" value="${f.hasta}" data-filtro="ventas.hasta"></label>
      <label class="filtro">Tienda <select data-filtro="ventas.tienda">${opcionesTienda(f.tienda)}</select></label>
      <label class="filtro">Pago <select data-filtro="ventas.metodo">
        <option value="">Todos</option>${Object.entries(METODOS).map(([k, v]) =>
          `<option value="${k}" ${f.metodo === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
    </div>
    <section class="indicadores chicos">
      <div class="indicador"><span>Ventas</span><strong class="num">${tot.ventas}</strong></div>
      <div class="indicador"><span>Vendido</span><strong class="num">${L.dinero(tot.vendido)}</strong></div>
      <div class="indicador"><span>Ganancia</span><strong class="num">${L.dinero(tot.ganancia)}</strong>
        <small>${L.porcentaje(tot.ganancia, tot.vendido) ?? 0}% · sin las anuladas${f.metodo ? ', todos los pagos' : ''}</small></div>
    </section>
    <section class="bloque">
      ${lista.ventas.length ? `<table class="tabla filas-tocables">
        <thead><tr><th>Factura</th><th>Fecha</th><th>Tienda</th><th>Atendió</th><th>Pago</th><th class="d">Total</th></tr></thead>
        <tbody>${lista.ventas.map((v) => `<tr data-accion="ver-venta" data-id="${v.id}" class="${v.anulada ? 'anulada' : ''}" tabindex="0">
          <td><strong>${esc(prefijoDe(v.tienda_id))}-${v.numero}</strong>${v.anulada ? ' <span class="etiqueta-mala">ANULADA</span>' : ''}</td>
          <td>${L.fechaHora(v.ocurrido_en)}</td>
          <td>${esc(v.tienda)}</td>
          <td>${esc(v.vendedor ?? '—')}</td>
          <td>${METODOS[v.metodo_pago] ?? esc(v.metodo_pago)}${v.cliente ? ` · ${esc(v.cliente)}` : ''}</td>
          <td class="d num">${L.dinero(v.total)}</td></tr>`).join('')}</tbody>
      </table>` : '<p class="vacio">No hay ventas en ese rango.</p>'}
      <div class="paginas">
        ${f.pagina > 1 ? '<button class="btn btn-chico" data-accion="pagina" data-delta="-1">← Anteriores</button>' : ''}
        ${lista.ventas.length === lista.por_pagina ? '<button class="btn btn-chico" data-accion="pagina" data-delta="1">Más ventas →</button>' : ''}
      </div>
    </section>`;
}

async function verVenta(id) {
  const { venta: v, lineas } = await traer(`/ventas/${id}`);
  abrirModal(`<div class="factura">
    <div class="factura-cab">
      <div><strong>${esc(v.tienda)}</strong><br><span class="tenue">${L.fechaHora(v.ocurrido_en)}</span></div>
      <div class="factura-num">${esc(v.prefijo)}-${v.numero}</div>
    </div>
    ${v.anulada ? `<div class="resultado faltante">ANULADA${v.observaciones ? ` — ${esc(v.observaciones)}` : ''}</div>` : ''}
    <table class="detalle">
      <thead><tr><th>Cant.</th><th>Descripción</th><th>Precio</th><th>Importe</th></tr></thead>
      <tbody>${lineas.map((l) => `<tr>
        <td class="num">${L.cantidadTexto(l.cantidad)}${l.unidad_medida && l.unidad_medida !== 'Unidad' ? ` <span class="tenue">${esc(l.unidad_medida)}</span>` : ''}</td>
        <td>${esc(l.producto)}${Number(l.descuento) ? `<br><span class="tenue">rebaja − ${L.dinero(l.descuento)}</span>` : ''}</td>
        <td class="num">${L.dinero(l.precio_unitario)}</td><td class="num">${L.dinero(l.subtotal)}</td></tr>`).join('')}</tbody>
    </table>
    <table class="tabla-datos">
      ${Number(v.descuento) ? `<tr><td>Subtotal</td><td>${L.dinero(v.subtotal)}</td></tr>
        <tr><td>Rebajas</td><td>− ${L.dinero(v.descuento)}</td></tr>` : ''}
      <tr><td><strong>Total</strong></td><td><strong>${L.dinero(v.total)}</strong></td></tr>
    </table>
    <p class="tenue">${METODOS[v.metodo_pago] ?? esc(v.metodo_pago)}${v.cliente ? ` a <strong>${esc(v.cliente)}</strong>` : ''}
      ${v.vendedor ? ` · Atendió ${esc(v.vendedor)}` : ''}</p>
  </div>
  ${v.anulada ? '' : `<details class="anular">
    <summary>Anular esta venta…</summary>
    <p class="tenue">La mercadería vuelve al inventario y la venta deja de contar en los reportes y en la caja.
      No se borra: queda marcada como anulada, con el motivo.</p>
    <div class="campo"><label for="motivo">Motivo</label>
      <textarea id="motivo" rows="2" maxlength="255" placeholder="Ej.: el cliente devolvió la mercadería"></textarea></div>
    <button class="btn btn-peligro" data-accion="anular" data-id="${v.id}">Anular venta ${esc(v.prefijo)}-${v.numero}</button>
  </details>`}
  <div class="acciones">
    <button class="btn" data-accion="imprimir">Imprimir</button>
    <button class="btn btn-primario" data-accion="cerrar-modal">Cerrar</button>
  </div>`);
}

async function anular(id) {
  const motivo = document.getElementById('motivo').value.trim();
  if (motivo.length < 3) return avisar('Escriba el motivo de la anulación.', true);
  const { status, datos } = await api('POST', `/ventas/${id}/anular`, { motivo });
  if (status !== 200) return avisar(datos.error ?? `No se pudo anular (${status}).`, true);
  cerrarModal();
  avisar(`Venta anulada. Se devolvieron al inventario los productos de ${L.dinero(datos.total_devuelto)}.`);
  mostrarVista();
}

// =============================================================================
// INVENTARIO
// =============================================================================
async function vistaInventario() {
  const f = est.filtros.inventario;
  const { inventario } = await traer(`/reportes/inventario${f.tienda ? `?tienda_id=${f.tienda}` : ''}`);
  est.datos.inventario = inventario;
  contenido().innerHTML = `
    <div class="encabezado-vista"><h1>Inventario</h1></div>
    <div class="filtros">
      <label class="filtro">Tienda <select data-filtro="inventario.tienda">${opcionesTienda(f.tienda)}</select></label>
      <label class="filtro">Mostrar <select data-filtro="inventario.solo">
        <option value="todos" ${f.solo === 'todos' ? 'selected' : ''}>Todo</option>
        <option value="reponer" ${f.solo === 'reponer' ? 'selected' : ''}>Para reponer</option>
        <option value="negativo" ${f.solo === 'negativo' ? 'selected' : ''}>En negativo (revisar)</option>
      </select></label>
      <label class="filtro crece">Buscar <input type="search" value="${esc(f.buscar)}" placeholder="Nombre o código"
        data-filtro="inventario.buscar" data-vivo="1"></label>
    </div>
    <div id="tabla-inventario"></div>`;
  dibujarInventario();
}

function dibujarInventario() {
  const f = est.filtros.inventario;
  const filas = L.filtrarInventario(est.datos.inventario ?? [], f);
  const tot = filas.reduce((a, p) => ({ costo: a.costo + Number(p.valor_costo), venta: a.venta + Number(p.valor_venta) }),
    { costo: 0, venta: 0 });
  document.getElementById('tabla-inventario').innerHTML = filas.length ? `
    <section class="indicadores chicos">
      <div class="indicador"><span>Productos</span><strong class="num">${filas.length}</strong></div>
      <div class="indicador"><span>Valor a costo</span><strong class="num">${L.dinero(tot.costo)}</strong>
        <small>lo que se pagó por lo que hay</small></div>
      <div class="indicador"><span>Valor a precio de venta</span><strong class="num">${L.dinero(tot.venta)}</strong>
        <small>lo que se cobraría vendiéndolo todo</small></div>
    </section>
    <section class="bloque"><table class="tabla filas-tocables">
      <thead><tr><th>Código</th><th>Producto</th><th>Tienda</th><th class="d">Hay</th><th class="d">Mínimo</th>
        <th class="d">Costo</th><th class="d">Precio</th><th class="d">Valor a costo</th></tr></thead>
      <tbody>${filas.map((p) => `<tr data-accion="ver-movimientos" data-id="${p.producto_id}" data-tienda="${p.tienda_id}"
          class="${Number(p.cantidad) < 0 ? 'negativo' : p.necesita_reposicion ? 'reponer' : ''}" tabindex="0">
        <td class="tenue">${esc(p.codigo ?? '')}</td><td>${esc(p.producto)}</td><td>${esc(p.tienda)}</td>
        <td class="d num">${L.cantidadTexto(p.cantidad)}${Number(p.cantidad) < 0 ? ' <span class="etiqueta-mala">revisar</span>' : ''}</td>
        <td class="d num">${L.cantidadTexto(p.cantidad_minima)}</td>
        <td class="d num">${L.dinero(p.precio_costo)}</td><td class="d num">${L.dinero(p.precio_venta)}</td>
        <td class="d num">${L.dinero(p.valor_costo)}</td></tr>`).join('')}</tbody>
    </table>
    <p class="tenue">Toque un producto para ver todos sus movimientos: entradas, ventas, mermas y ajustes, con quién y cuándo.</p>
    </section>` : '<p class="vacio">No hay productos con ese filtro.</p>';
}

async function verMovimientos(productoId, tiendaId) {
  const p = (est.datos.inventario ?? []).find((x) => x.producto_id === productoId && x.tienda_id === tiendaId);
  const { movimientos } = await traer(`/reportes/movimientos/${productoId}?tienda_id=${tiendaId}`);
  const TIPOS = { entrada: 'Entrada', venta: 'Venta', devolucion: 'Devolución', merma: 'Merma', ajuste: 'Ajuste' };
  abrirModal(`<h2>${esc(p?.producto ?? 'Producto')}</h2>
    <p class="tenue">${esc(p?.tienda ?? '')} · hay ${L.cantidadTexto(p?.cantidad ?? 0)} ${esc(p?.unidad_medida ?? '')}
      · el stock es la suma de estos movimientos</p>
    ${movimientos.length ? `<table class="tabla">
      <thead><tr><th>Fecha</th><th>Tipo</th><th class="d">Cantidad</th><th>Motivo</th><th>Quién</th></tr></thead>
      <tbody>${movimientos.map((m) => `<tr>
        <td>${L.fechaHora(m.ocurrido_en)}</td><td>${TIPOS[m.tipo] ?? esc(m.tipo)}</td>
        <td class="d num ${Number(m.cantidad) < 0 ? 'texto-malo' : 'texto-bueno'}">${Number(m.cantidad) > 0 ? '+' : ''}${L.cantidadTexto(m.cantidad)}</td>
        <td>${esc(m.motivo ?? (m.venta_id ? 'venta' : ''))}</td><td>${esc(m.usuario ?? '—')}</td></tr>`).join('')}</tbody>
    </table>` : '<p class="vacio">Sin movimientos.</p>'}
    <div class="acciones"><button class="btn btn-primario" data-accion="cerrar-modal">Cerrar</button></div>`);
}

// =============================================================================
// POR COBRAR
// =============================================================================
async function vistaCobrar() {
  const f = est.filtros.cobrar;
  const r = await traer(`/reportes/cuentas-por-cobrar${f.todos ? '?todos=1' : ''}`);
  contenido().innerHTML = `
    <div class="encabezado-vista"><h1>Por cobrar</h1>
      <label class="filtro casilla"><input type="checkbox" ${f.todos ? 'checked' : ''} data-filtro="cobrar.todos">
        Incluir a los que no deben</label></div>
    <section class="indicadores chicos">
      <div class="indicador"><span>Total por cobrar</span><strong class="num">${L.dinero(r.total)}</strong></div>
      <div class="indicador"><span>Clientes</span><strong class="num">${r.clientes.filter((c) => Number(c.saldo) > 0).length}</strong>
        <small>con deuda</small></div>
    </section>
    <section class="bloque">${r.clientes.length ? `<table class="tabla filas-tocables">
      <thead><tr><th>Cliente</th><th>Teléfono</th><th class="d">Debe</th><th class="d">Límite</th><th class="d">Cupo</th>
        <th>Última compra</th><th>Último abono</th></tr></thead>
      <tbody>${r.clientes.map((c) => `<tr data-accion="ver-cliente" data-id="${c.cliente_id}" tabindex="0"
          class="${Number(c.cupo_disponible) <= 0 && Number(c.saldo) > 0 ? 'negativo' : ''}">
        <td><strong>${esc(c.nombre)}</strong></td><td>${esc(c.telefono ?? '')}</td>
        <td class="d num"><strong>${L.dinero(c.saldo)}</strong></td><td class="d num">${L.dinero(c.limite_credito)}</td>
        <td class="d num">${L.dinero(c.cupo_disponible)}</td>
        <td>${c.ultima_venta ? L.fechaHora(c.ultima_venta) : '—'}</td>
        <td>${c.ultimo_abono ? L.fechaHora(c.ultimo_abono) : '—'}</td></tr>`).join('')}</tbody>
    </table>` : '<p class="vacio">Nadie debe nada.</p>'}</section>`;
}

async function verCliente(id) {
  const { cliente: c, ventas_fiadas: fiado, abonos } = await traer(`/clientes/${id}/estado-cuenta`);
  abrirModal(`<h2>${esc(c.nombre)}</h2>
    <p class="tenue">${esc(c.telefono ?? 'sin teléfono')}</p>
    <section class="indicadores chicos">
      <div class="indicador"><span>Debe</span><strong class="num">${L.dinero(c.saldo)}</strong></div>
      <div class="indicador"><span>Fiado</span><strong class="num">${L.dinero(c.total_fiado)}</strong></div>
      <div class="indicador"><span>Abonado</span><strong class="num">${L.dinero(c.total_abonado)}</strong></div>
      <div class="indicador"><span>Cupo</span><strong class="num">${L.dinero(c.cupo_disponible)}</strong></div>
    </section>
    <div class="dos-columnas">
      <div><h3>Ventas fiadas</h3>${fiado.length ? `<table class="tabla">${fiado.map((v) => `<tr class="${v.anulada ? 'anulada' : ''}">
        <td>${L.fechaHora(v.ocurrido_en)}<br><span class="tenue">${esc(v.tienda)} · N.º ${v.numero}${v.anulada ? ' · anulada' : ''}</span></td>
        <td class="d num">${L.dinero(v.total)}</td></tr>`).join('')}</table>` : '<p class="vacio">Ninguna.</p>'}</div>
      <div><h3>Abonos</h3>${abonos.length ? `<table class="tabla">${abonos.map((a) => `<tr>
        <td>${L.fechaHora(a.ocurrido_en)}<br><span class="tenue">${esc(METODOS[a.metodo_pago] ?? a.metodo_pago)}${a.recibido_por ? ` · recibió ${esc(a.recibido_por)}` : ''}</span></td>
        <td class="d num">${L.dinero(a.monto)}</td></tr>`).join('')}</table>` : '<p class="vacio">Ninguno.</p>'}</div>
    </div>
    <details class="extra"><summary>Cambiar el límite de crédito…</summary>
      <p class="tenue">Es cuánto puede deber entre las dos tiendas. Bajarlo por debajo de lo que ya debe no borra la deuda:
        solo impide fiarle más.</p>
      <div class="campo"><label for="limite">Límite nuevo</label>
        <input id="limite" type="number" min="0" step="any" value="${Number(c.limite_credito)}"></div>
      <button class="btn btn-primario" data-accion="guardar-limite" data-id="${c.cliente_id}">Guardar límite</button>
    </details>
    <div class="acciones"><button class="btn btn-primario" data-accion="cerrar-modal">Cerrar</button></div>`);
}

async function guardarLimite(id) {
  const valor = document.getElementById('limite').value;
  const limite = Number(valor);
  if (valor === '' || !(limite >= 0)) return avisar('Escriba un límite válido (0 o más).', true);
  const { status, datos } = await api('PATCH', `/clientes/${id}`, { limite_credito: limite });
  if (status !== 200) return avisar(datos.error ?? `No se pudo guardar (${status}).`, true);
  avisar('Límite actualizado.');
  await verCliente(id);
  mostrarVistaSinPerderModal();
}

// =============================================================================
// CAJAS
// =============================================================================
async function vistaCajas() {
  const f = est.filtros.cajas;
  const q = new URLSearchParams();
  if (f.tienda) q.set('tienda_id', f.tienda);
  if (f.estado) q.set('estado', f.estado);
  const { cajas } = await traer(`/reportes/cuadre-caja?${q}`);
  contenido().innerHTML = `
    <div class="encabezado-vista"><h1>Cajas</h1></div>
    <div class="filtros">
      <label class="filtro">Tienda <select data-filtro="cajas.tienda">${opcionesTienda(f.tienda)}</select></label>
      <label class="filtro">Estado <select data-filtro="cajas.estado">
        <option value="">Todas</option>
        <option value="abierta" ${f.estado === 'abierta' ? 'selected' : ''}>Abiertas</option>
        <option value="cerrada" ${f.estado === 'cerrada' ? 'selected' : ''}>Cerradas</option>
      </select></label>
    </div>
    <section class="bloque">${cajas.length ? `<table class="tabla filas-tocables">
      <thead><tr><th>Turno</th><th>Tienda</th><th>Abrió</th><th class="d">Debería haber</th><th class="d">Contado</th>
        <th class="d">Diferencia</th><th>Resultado</th></tr></thead>
      <tbody>${cajas.map((c) => {
        const r = L.resultadoCaja(c);
        return `<tr data-accion="ver-caja" data-id="${c.caja_id}" tabindex="0" class="${r.clase}">
          <td>${L.fechaHora(c.abierta_en)}<br><span class="tenue">${c.cerrada_en ? `cerró ${L.fechaHora(c.cerrada_en)}` : 'abierta'}</span></td>
          <td>${esc(c.tienda)}</td><td>${esc(c.usuario ?? '—')}</td>
          <td class="d num">${L.dinero(c.esperado)}</td>
          <td class="d num">${c.efectivo_contado == null ? '—' : L.dinero(c.efectivo_contado)}</td>
          <td class="d num">${c.diferencia_real == null ? '—' : L.dinero(c.diferencia_real)}</td>
          <td><span class="etiqueta-${r.clase || 'neutra'}">${esc(r.texto)}</span></td></tr>`;
      }).join('')}</tbody>
    </table>` : '<p class="vacio">No hay cajas con ese filtro.</p>'}</section>`;
}

async function verCaja(id) {
  const { caja: c, ventas, abonos } = await traer(`/caja/${id}`);
  const r = L.resultadoCaja(c);
  abrirModal(`<h2>Caja de ${esc(c.tienda)}</h2>
    <p class="tenue">${esc(c.usuario ?? '')} · ${L.fechaHora(c.abierta_en)}${c.cerrada_en ? ` a ${L.fechaHora(c.cerrada_en)}` : ' · sigue abierta'}</p>
    <div class="resultado ${r.clase || 'cuadra'}">${esc(r.texto)}</div>
    <table class="tabla-datos">
      <tr><td>Monto inicial</td><td>${L.dinero(c.monto_inicial)}</td></tr>
      <tr><td>Ventas en efectivo</td><td>${L.dinero(c.vendido_efectivo)}</td></tr>
      <tr><td>Abonos en efectivo</td><td>${L.dinero(c.abonado_efectivo)}</td></tr>
      <tr><td><strong>Debería haber</strong></td><td><strong>${L.dinero(c.esperado)}</strong></td></tr>
      ${c.efectivo_contado == null ? '' : `<tr><td>Contado al cerrar</td><td>${L.dinero(c.efectivo_contado)}</td></tr>
        <tr><td><strong>Diferencia</strong></td><td><strong>${L.dinero(c.diferencia_real)}</strong></td></tr>`}
    </table>
    ${c.cuadra === false ? `<p class="nota">La diferencia que se guardó al cerrar (${L.dinero(c.diferencia_registrada)}) no coincide
      con la que sale de las ventas (${L.dinero(c.diferencia_real)}). Probablemente se anuló una venta después del cierre.</p>` : ''}
    <div class="dos-columnas">
      <div><h3>Ventas del turno</h3>${ventas.length ? `<table class="tabla">${ventas.map((v) => `<tr class="${v.anulada ? 'anulada' : ''}">
        <td>N.º ${v.numero} · ${L.hora(v.ocurrido_en)}<br><span class="tenue">${METODOS[v.metodo_pago] ?? esc(v.metodo_pago)}${v.anulada ? ' · anulada' : ''}</span></td>
        <td class="d num">${L.dinero(v.total)}</td></tr>`).join('')}</table>` : '<p class="vacio">Ninguna.</p>'}</div>
      <div><h3>Abonos recibidos</h3>${abonos.length ? `<table class="tabla">${abonos.map((a) => `<tr>
        <td>${esc(a.cliente)} · ${L.hora(a.ocurrido_en)}<br><span class="tenue">${esc(METODOS[a.metodo_pago] ?? a.metodo_pago)}</span></td>
        <td class="d num">${L.dinero(a.monto)}</td></tr>`).join('')}</table>` : '<p class="vacio">Ninguno.</p>'}</div>
    </div>
    <div class="acciones"><button class="btn btn-primario" data-accion="cerrar-modal">Cerrar</button></div>`);
}

// =============================================================================
// TABLETS
// =============================================================================
async function vistaTablets() {
  const { dispositivos } = await traer('/sync/estado');
  contenido().innerHTML = `
    <div class="encabezado-vista"><h1>Tablets</h1></div>
    <p class="tenue">Cuándo envió cada tablet sus ventas por última vez. Una tablet que lleva horas sin enviar
      puede estar sin señal o apagada: sus ventas todavía no aparecen en el panel.</p>
    <section class="bloque">${dispositivos.length ? `<table class="tabla">
      <thead><tr><th>Tablet</th><th>Tienda</th><th>Último envío</th><th>Estado</th></tr></thead>
      <tbody>${dispositivos.map((d) => {
        const e = L.estadoSincronizacion(d.minutos_sin_sincronizar);
        return `<tr class="${e.clase}"><td><strong>${esc(d.nombre)}</strong></td><td>${esc(d.tienda)}</td>
          <td>${d.ultimo_sync ? L.fechaHora(d.ultimo_sync) : 'nunca'}</td>
          <td><span class="etiqueta-${e.clase || 'neutra'}">${esc(e.texto)}</span></td></tr>`;
      }).join('')}</tbody>
    </table>` : '<p class="vacio">No hay tablets registradas.</p>'}
    <p class="tenue">Solo aparecen las tablets dadas de alta en el sistema.</p></section>`;
  // PENDIENTE: el punto de venta (cliente/app.js) manda /sync/push sin
  // dispositivo_id, asi que sus envios no actualizan DISPOSITIVO.ultimo_sync
  // ni esta lista. Hace falta:
  //   - dar de alta cada tablet (hoy no hay ruta para crear un DISPOSITIVO);
  //   - que la tablet guarde su id y lo mande en cada envio.
}

// =============================================================================
// EVENTOS
// =============================================================================
function mostrarVistaSinPerderModal() {
  // Recarga la vista de fondo (por ejemplo, el saldo de un cliente) sin
  // cerrar la ventana que el duenio tiene abierta.
  const modal = document.getElementById('modal');
  const abierto = !modal.hidden;
  const html = modal.innerHTML;
  mostrarVista().then(() => { if (abierto) { modal.innerHTML = html; modal.hidden = false; } });
}

const conError = (fn) => async (...a) => {
  try { await fn(...a); } catch (err) { if (est.sesion) avisar(err.message, true); }
};

const acciones = {
  actualizar: () => mostrarVista(),
  salir: () => salir(),
  'cerrar-modal': () => cerrarModal(),
  imprimir: () => window.print(),
  'ver-venta': conError((d) => verVenta(Number(d.id))),
  anular: conError((d) => anular(Number(d.id))),
  'ver-movimientos': conError((d) => verMovimientos(Number(d.id), Number(d.tienda))),
  'ver-cliente': conError((d) => verCliente(Number(d.id))),
  'guardar-limite': conError((d) => guardarLimite(Number(d.id))),
  'ver-caja': conError((d) => verCaja(Number(d.id))),
  pagina: (d) => {
    est.filtros.ventas.pagina = Math.max(1, est.filtros.ventas.pagina + Number(d.delta));
    mostrarVista();
  },
  'ver-reposicion': () => { est.filtros.inventario.solo = 'reponer'; },
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-accion]');
  if (!el) { if (e.target.id === 'modal') cerrarModal(); return; }
  const fn = acciones[el.dataset.accion];
  if (fn) fn(el.dataset);
});

// Las filas de las tablas se abren tambien con Enter: el panel se usa con
// teclado en la computadora.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !document.getElementById('modal').hidden) return cerrarModal();
  if (e.key === 'Enter' && e.target.matches('tr[data-accion]')) e.target.click();
});

// Filtros: cambiar uno vuelve a pedir los datos, salvo la busqueda del
// inventario, que filtra lo ya traido mientras se escribe.
document.addEventListener('change', (e) => {
  const clave = e.target.dataset?.filtro;
  if (!clave || e.target.dataset.vivo) return;
  const [vista, campo] = clave.split('.');
  est.filtros[vista][campo] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
  if (vista === 'ventas') est.filtros.ventas.pagina = 1;
  if (vista === 'inventario' && campo === 'solo') return dibujarInventario();
  mostrarVista();
});
document.addEventListener('input', (e) => {
  if (e.target.dataset?.filtro !== 'inventario.buscar') return;
  est.filtros.inventario.buscar = e.target.value;
  dibujarInventario();
});

window.addEventListener('hashchange', () => { cerrarModal(); mostrarVista(); });

// =============================================================================
// ARRANQUE
// =============================================================================
async function arrancar() {
  try {
    const { datos } = await api('GET', '/tiendas', undefined, { conSesion: false });
    est.tiendas = datos.tiendas ?? [];
  } catch (err) {
    return pantallaIngreso(err.message);
  }
  dibujarMarco();
  // El dia del negocio lo dice el servidor; los filtros de fecha parten de ahi.
  try { est.hoy = (await traer('/reportes/resumen')).fecha; } catch { /* se intenta al mostrar */ }
  mostrarVista();
}

if (est.sesion && new Date(est.sesion.expira_en) < new Date()) { est.sesion = null; guardarSesion(null); }
if (est.sesion && est.sesion.usuario?.rol !== 'administrador') { est.sesion = null; guardarSesion(null); }

document.addEventListener('submit', (e) => { if (e.target.id === 'form-ingreso') ingresar(e); });
if (est.sesion) arrancar(); else pantallaIngreso();
