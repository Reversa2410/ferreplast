// =============================================================================
// Las figuras del MER, construidas desde el modelo final (db/schema.sql).
//
// Cada funcion devuelve el SVG con clases; _generar.mjs lo convierte en un
// archivo autocontenido. Si cambia una tabla, se cambia ATR mas abajo y se
// corre `npm run diagramas`: las cuatro vistas que la muestran se rehacen
// solas, con los conectores recalculados.
// =============================================================================

import { Lienzo, leyenda, titulo, anchoTexto } from './_dibujo.mjs';

// ---- Atributos de cada entidad, tal como estan en db/schema.sql -------------
// [texto, clase]: 'pk' clave primaria, 'atr' atributo, 'der' derivado o calculado.
const pk = (t) => [t, 'pk'];
const a = (t) => [t, 'atr'];
const d = (t) => [t, 'der'];

const ATR = {
  NEGOCIO:        [pk('id'), a('nombre, propietario'), a('moneda, activo')],
  TIENDA:         [pk('id'), a('nombre, tipo'), a('direccion, prefijo'), a('negocio_id (FK)')],
  CATEGORIA:      [pk('id'), a('nombre'), a('padre_id (FK)')],
  PRODUCTO:       [pk('id'), a('codigo, nombre'), a('precio_costo'), a('precio_venta'),
                   a('unidad_medida'), a('categoria_id (FK)')],
  STOCK:          [pk('tienda_id + producto_id'), d('cantidad (derivado)'), a('cantidad_minima'),
                   d('necesita_reposicion (calc.)')],
  CLIENTE:        [pk('id'), a('nombre, telefono'), a('identificacion'), a('limite_credito'),
                   d('saldo (derivado)'), a('negocio_id (FK)')],
  USUARIO:        [pk('id'), a('nombre, rol'), a('activo, ultimo_acceso'), a('negocio_id (FK)')],
  USUARIO_TIENDA: [pk('usuario_id + tienda_id'), a('created_at')],
  DISPOSITIVO:    [pk('id'), a('nombre, ultimo_sync'), a('tienda_id (FK)')],
  SYNC_LOG:       [pk('id'), a('enviados, aceptados'), a('duplicados, error'), a('dispositivo_id (FK)')],
  SESION:         [pk('token_hash'), a('expira_en, revocada_en'), a('tienda_id (FK)'),
                   a('usuario_id, dispositivo_id (FK)')],
  INTENTO_LOGIN:  [pk('id'), a('identificador, exitoso'), a('ip, created_at'), a('tienda_id (FK)')],
  CAJA:           [pk('id'), a('monto_inicial'), a('efectivo_contado'), d('diferencia (calculada)'),
                   a('estado, abierta_en'), a('tienda_id, usuario_id (FK)')],
  VENTA:          [pk('id'), a('uuid_externo, numero'), a('subtotal, descuento, total'),
                   a('metodo_pago, anulada'), a('ocurrido_en'), a('tienda_id, usuario_id (FK)'),
                   a('caja_id, cliente_id (FK)')],
  VENTA_LINEA:    [pk('venta_id + numero'), a('producto_id (FK)'), a('cantidad'),
                   a('precio_unitario *'), a('costo_unitario *'), a('descuento (mayoreo)'), a('subtotal')],
  MOVIMIENTO_INVENTARIO: [pk('id'), a('uuid_externo'), a('tipo, cantidad (+/-)'),
                   a('costo_unitario, motivo'), a('ocurrido_en'), a('tienda_id, producto_id (FK)'),
                   a('usuario_id, venta_id (FK)')],
  PAGO_CREDITO:   [pk('id'), a('monto, metodo_pago'), a('ocurrido_en'), a('cliente_id (FK)'),
                   a('caja_id, usuario_id (FK)')],
};

const NOTAS = {
  VENTA_LINEA: '* congelado al vender',
  MOVIMIENTO_INVENTARIO: 'solo insercion (inmutable)',
};

const TIPO = {
  STOCK: 'asociativa', USUARIO_TIENDA: 'asociativa', VENTA_LINEA: 'debil',
};

// ---- Relaciones: una por clave foranea --------------------------------------
// [desde (lado 1), hasta (lado N), cardinalidad, verbo, opciones]
const AMB = { clase: 'rel-amb' };
const REL = [
  ['NEGOCIO', 'TIENDA', '1 : N', 'posee'],
  ['NEGOCIO', 'USUARIO', '1 : N', 'emplea'],
  ['NEGOCIO', 'CLIENTE', '1 : N', 'da credito a'],
  ['CATEGORIA', 'CATEGORIA', '0..1 : N', 'contiene', { ...AMB, lados: { desde: 'derecha', hasta: 'arriba' } }],
  ['CATEGORIA', 'PRODUCTO', '1 : N', 'agrupa'],
  ['TIENDA', 'STOCK', '1 : N', 'almacena', AMB],
  ['PRODUCTO', 'STOCK', '1 : N', 'existe en', AMB],
  ['TIENDA', 'USUARIO_TIENDA', '1 : N', 'cuenta con', AMB],
  ['USUARIO', 'USUARIO_TIENDA', '1 : N', 'trabaja en', AMB],
  ['TIENDA', 'DISPOSITIVO', '1 : N', 'instala'],
  ['DISPOSITIVO', 'SYNC_LOG', '1 : N', 'registra'],
  ['TIENDA', 'CAJA', '1 : N', 'opera'],
  ['USUARIO', 'CAJA', '1 : N', 'abre'],
  ['TIENDA', 'VENTA', '1 : N', 'vende'],
  ['USUARIO', 'VENTA', '0..1 : N', 'atiende'],
  ['CAJA', 'VENTA', '0..1 : N', 'cobra'],
  ['CLIENTE', 'VENTA', '0..1 : N', 'fia'],
  ['VENTA', 'VENTA_LINEA', '1 : N', 'detalla', { clase: 'rel-amb', identificadora: true }],
  ['PRODUCTO', 'VENTA_LINEA', '1 : N', 'se vende en'],
  ['TIENDA', 'MOVIMIENTO_INVENTARIO', '1 : N', 'registra'],
  ['PRODUCTO', 'MOVIMIENTO_INVENTARIO', '1 : N', 'afecta'],
  ['USUARIO', 'MOVIMIENTO_INVENTARIO', '0..1 : N', 'ejecuta'],
  ['VENTA', 'MOVIMIENTO_INVENTARIO', '0..1 : N', 'origina'],
  ['CLIENTE', 'PAGO_CREDITO', '1 : N', 'abona'],
  ['CAJA', 'PAGO_CREDITO', '0..1 : N', 'recibe'],
  ['USUARIO', 'PAGO_CREDITO', '0..1 : N', 'cobra'],
  ['USUARIO', 'SESION', '1 : N', 'inicia'],
  ['DISPOSITIVO', 'SESION', '0..1 : N', 'aloja'],
  ['TIENDA', 'SESION', '0..1 : N', 'opera desde'],
  ['TIENDA', 'INTENTO_LOGIN', '0..1 : N', 'recibe'],
];

export const RESUMEN = {
  entidades: Object.keys(ATR).length,
  relaciones: REL.length,
  nombres: Object.keys(ATR),
};

/** Coloca entidades y relaciones de una vista sobre el lienzo. */
function poblar(lz, posiciones, { contexto = [], lados = {}, orden } = {}) {
  for (const [id, pos] of Object.entries(posiciones)) {
    const ctx = contexto.includes(id);
    lz.entidad(id, {
      ...pos,
      tipo: ctx ? 'contexto' : (TIPO[id] ?? 'fuerte'),
      atributos: ctx ? [a('id (PK)')] : ATR[id],
      nota: ctx ? undefined : NOTAS[id],
    });
  }
  const presentes = REL.filter(([x, y]) => posiciones[x] && posiciones[y])
    // Una relacion entre dos entidades de contexto ya se dibujo en su vista.
    .filter(([x, y]) => !(contexto.includes(x) && contexto.includes(y)));
  const lista = orden
    ? [...presentes].sort((p, q) => rango(orden, p) - rango(orden, q))
    : presentes;
  for (const [x, y, card, verbo, op = {}] of lista) {
    lz.relacion(x, y, { card, verbo, ...op, lados: lados[`${x}>${y}`] ?? op.lados ?? {} });
  }
}

function rango(orden, [x, y]) {
  const i = orden.indexOf(`${x}>${y}`);
  return i === -1 ? 1000 : i;
}

// =============================================================================
// 00 -- Modelo completo
// =============================================================================
export function modeloCompleto() {
  const lz = new Lienzo(2300, 1400);
  titulo(lz, 'FERREPLAST', 'Modelo Entidad-Relación Extendido',
    `${RESUMEN.entidades} entidades · ${RESUMEN.relaciones} relaciones · 1 jerarquía ISA`);

  const col = { A: 60, B: 440, C: 820, D: 1200, E: 1580, F: 1960 };
  const R1 = 160, R2 = 400, R3 = 760, R4 = 1080;
  const W = 280;

  const pos = {
    CATEGORIA:      { x: col.A, y: R1, ancho: W },
    INTENTO_LOGIN:  { x: col.B, y: R1, ancho: W },
    NEGOCIO:        { x: col.C, y: R1, ancho: W },
    SESION:         { x: col.D, y: R1, ancho: W },
    DISPOSITIVO:    { x: col.E, y: R1, ancho: W },
    SYNC_LOG:       { x: col.F, y: R1, ancho: W },

    PRODUCTO:       { x: col.A, y: R2, ancho: W },
    STOCK:          { x: col.B, y: R2, ancho: W },
    TIENDA:         { x: col.C, y: R2, ancho: W },
    USUARIO_TIENDA: { x: col.D, y: R2, ancho: W },
    USUARIO:        { x: col.E, y: R2, ancho: W },

    MOVIMIENTO_INVENTARIO: { x: col.A, y: R3, ancho: W },
    VENTA_LINEA:    { x: col.B, y: R3, ancho: W },
    VENTA:          { x: col.C, y: R3, ancho: W },
    CAJA:           { x: col.D, y: R3, ancho: W },

    CLIENTE:        { x: col.C, y: R4, ancho: W },
    PAGO_CREDITO:   { x: col.D, y: R4, ancho: W },
  };

  for (const [id, p] of Object.entries(pos)) {
    lz.entidad(id, { ...p, tipo: TIPO[id] ?? 'fuerte', atributos: ATR[id], nota: NOTAS[id] });
  }

  // Jerarquia ISA bajo USUARIO, dibujada a mano: no es una relacion de clave
  // foranea sino una especializacion dentro de la misma tabla.
  const u = lz.cajas.get('USUARIO');
  isa(lz, u, [
    { id: 'ADMINISTRADOR', x: col.E, ancho: W,
      atributos: [a('email, password_hash'), d('sin tienda: ve las dos')] },
    { id: 'EMPLEADO', x: col.F, ancho: W,
      atributos: [a('pin_hash'), d('1 o mas tiendas')] },
  ], R3);

  leyenda(lz, 60, 1340, ['fuerte', 'debil', 'asociativa', 'derivado', 'rel', 'rel-amb', 'pk']);

  for (const [x, y, card, verbo, op = {}] of ordenar(REL, [
    'CATEGORIA>CATEGORIA', 'CATEGORIA>PRODUCTO', 'NEGOCIO>TIENDA', 'TIENDA>STOCK', 'PRODUCTO>STOCK',
    'TIENDA>USUARIO_TIENDA', 'USUARIO>USUARIO_TIENDA', 'VENTA>VENTA_LINEA', 'TIENDA>VENTA',
    'CAJA>VENTA', 'CLIENTE>PAGO_CREDITO', 'CAJA>PAGO_CREDITO', 'CLIENTE>VENTA', 'TIENDA>CAJA',
    'DISPOSITIVO>SYNC_LOG', 'DISPOSITIVO>SESION', 'USUARIO>SESION', 'TIENDA>SESION',
    'TIENDA>INTENTO_LOGIN', 'TIENDA>DISPOSITIVO', 'NEGOCIO>USUARIO', 'PRODUCTO>VENTA_LINEA',
    'PRODUCTO>MOVIMIENTO_INVENTARIO', 'VENTA>MOVIMIENTO_INVENTARIO', 'USUARIO>CAJA',
  ])) {
    lz.relacion(x, y, { card, verbo, ...op });
  }
  lz.trazar();
  return entregar(lz, 'Modelo entidad-relacion extendido completo de Ferreplast: diecisiete entidades y treinta relaciones. El negocio agrupa tiendas, usuarios y clientes. El stock resuelve la relacion muchos a muchos entre tienda y producto, y USUARIO_TIENDA la de usuario y tienda. Las ventas se detallan en lineas de venta, entidad debil. Los movimientos de inventario registran cada cambio de stock. Los clientes con credito abonan a su cuenta. El usuario se especializa en administrador y empleado.');
}

function ordenar(lista, orden) {
  return [...lista].sort((p, q) => rango(orden, p) - rango(orden, q));
}

/** Especializacion total y disjunta: doble linea, circulo "d" y triangulo ISA. */
function isa(lz, padre, hijos, yHijos) {
  const cx = padre.x + padre.w / 2;
  const y0 = padre.y + padre.h;
  const yc = y0 + 50;              // centro del circulo
  const yt = yc + 26;              // punta del triangulo
  const yb = yt + 44;              // barra que reparte a los subtipos
  // Zona reservada para que ningun conector pase por el simbolo.
  lz.reservar(cx - 40, y0 + 10, 80, yb - y0 - 10);
  lz.trazoFijo([[cx, y0], [cx, yc - 16]],
    `<line class="rel-amb" x1="${cx - 3}" y1="${y0}" x2="${cx - 3}" y2="${yc - 16}"/>` +
    `\n  <line class="rel-amb" x1="${cx + 3}" y1="${y0}" x2="${cx + 3}" y2="${yc - 16}"/>`);
  lz.fondo.push(`<text class="verb" x="${cx + 26}" y="${yc - 4}">total</text>`);
  lz.fondo.push(`<text class="verb" x="${cx + 26}" y="${yc + 12}">disjunta</text>`);
  lz.trazos.push(`<circle class="circ-d" cx="${cx}" cy="${yc}" r="16"/>`);
  lz.trazos.push(`<text class="card-amb" x="${cx}" y="${yc + 4}" text-anchor="middle">d</text>`);
  lz.trazos.push(`<line class="rel-amb" x1="${cx}" y1="${yc + 16}" x2="${cx}" y2="${yt}"/>`);
  lz.trazos.push(`<polygon class="tri-isa" points="${cx},${yt} ${cx - 30},${yt + 28} ${cx + 30},${yt + 28}"/>`);
  lz.trazos.push(`<text class="card-amb" x="${cx}" y="${yt + 23}" text-anchor="middle">ISA</text>`);
  const xs = hijos.map((h) => h.x + h.ancho / 2);
  lz.trazoFijo([[cx, yt + 28], [cx, yb]], `<line class="rel-amb" x1="${cx}" y1="${yt + 28}" x2="${cx}" y2="${yb}"/>`);
  lz.trazoFijo([[Math.min(...xs), yb], [Math.max(...xs), yb]],
    `<line class="rel-amb" x1="${Math.min(...xs)}" y1="${yb}" x2="${Math.max(...xs)}" y2="${yb}"/>`);
  for (const h of hijos) {
    const hx = h.x + h.ancho / 2;
    lz.trazoFijo([[hx, yb], [hx, yHijos]], `<line class="rel-amb" x1="${hx}" y1="${yb}" x2="${hx}" y2="${yHijos}"/>`);
    lz.entidad(h.id, { x: h.x, y: yHijos, ancho: h.ancho, atributos: h.atributos });
  }
}

function entregar(lz, aria) {
  if (lz.avisos.length) {
    const mensaje = `El trazado no cerro:\n  ${lz.avisos.join('\n  ')}`;
    // DIAGRAMAS_BORRADOR=1 deja ver el dibujo a medias para corregir la
    // ubicacion de las cajas; sin eso, un diagrama incompleto no se escribe.
    if (process.env.DIAGRAMAS_BORRADOR) console.warn(mensaje);
    else throw new Error(mensaje);
  }
  return lz.svg(aria);
}

// =============================================================================
// 01 -- Vista de estructura: negocio, catalogo, personas
// =============================================================================
export function vistaEstructura() {
  const lz = new Lienzo(1820, 720);
  titulo(lz, 'Vista de estructura', 'Negocio, tiendas, catálogo y personas');
  const W = 260;
  poblar(lz, {
    CATEGORIA:      { x: 60,   y: 150, ancho: W },
    NEGOCIO:        { x: 780,  y: 150, ancho: W },
    CLIENTE:        { x: 1500, y: 150, ancho: W },
    PRODUCTO:       { x: 60,   y: 420, ancho: W },
    STOCK:          { x: 420,  y: 420, ancho: W },
    TIENDA:         { x: 780,  y: 420, ancho: W },
    USUARIO_TIENDA: { x: 1140, y: 420, ancho: W },
    USUARIO:        { x: 1500, y: 420, ancho: W },
  }, { orden: ['CATEGORIA>CATEGORIA', 'CATEGORIA>PRODUCTO', 'NEGOCIO>TIENDA', 'TIENDA>STOCK',
               'PRODUCTO>STOCK', 'TIENDA>USUARIO_TIENDA', 'USUARIO>USUARIO_TIENDA'] });
  leyenda(lz, 60, 680, ['fuerte', 'asociativa', 'derivado', 'rel', 'rel-amb', 'pk']);
  lz.trazar();
  return entregar(lz, 'Vista de estructura del modelo: el negocio posee las tiendas, emplea a los usuarios y da credito a los clientes. El catalogo es unico; STOCK resuelve la relacion muchos a muchos entre tienda y producto, y USUARIO_TIENDA la de usuario y tienda. CATEGORIA se contiene a si misma.');
}

// =============================================================================
// 02 -- Vista de operacion: venta, caja, credito, inventario
// =============================================================================
export function vistaOperacion() {
  const lz = new Lienzo(1820, 1000);
  titulo(lz, 'Vista de operación', 'Ventas, caja, crédito y movimientos de inventario');
  const W = 260;
  poblar(lz, {
    PRODUCTO:       { x: 60,   y: 150, ancho: W },
    TIENDA:         { x: 780,  y: 150, ancho: W },
    USUARIO:        { x: 1500, y: 150, ancho: W },
    MOVIMIENTO_INVENTARIO: { x: 60, y: 400, ancho: W },
    VENTA_LINEA:    { x: 420,  y: 400, ancho: W },
    VENTA:          { x: 780,  y: 400, ancho: W },
    CAJA:           { x: 1140, y: 400, ancho: W },
    CLIENTE:        { x: 780,  y: 720, ancho: W },
    PAGO_CREDITO:   { x: 1140, y: 720, ancho: W },
  }, {
    contexto: ['PRODUCTO', 'TIENDA', 'USUARIO'],
    orden: ['VENTA>VENTA_LINEA', 'TIENDA>VENTA', 'CAJA>VENTA', 'CLIENTE>VENTA', 'CLIENTE>PAGO_CREDITO',
            'CAJA>PAGO_CREDITO', 'TIENDA>CAJA', 'USUARIO>CAJA', 'PRODUCTO>VENTA_LINEA',
            'PRODUCTO>MOVIMIENTO_INVENTARIO', 'VENTA>MOVIMIENTO_INVENTARIO'],
  });
  // CLIENTE es de la vista de estructura; aca entra completo porque el credito
  // es parte de la operacion y su saldo derivado es lo que se quiere mostrar.
  leyenda(lz, 60, 960, ['fuerte', 'debil', 'contexto', 'derivado', 'rel', 'rel-amb']);
  lz.trazar();
  return entregar(lz, 'Vista de operacion del modelo: la venta pertenece a una tienda, la atiende un usuario, se cobra en una caja y, si es fiada, se carga a un cliente. Se detalla en lineas de venta, entidad debil, y origina movimientos de inventario. Los abonos del cliente entran por la caja.');
}

// =============================================================================
// 09 -- Vista de acceso y sincronizacion
// =============================================================================
export function vistaAcceso() {
  const lz = new Lienzo(1500, 700);
  titulo(lz, 'Vista de acceso y sincronización', 'Sesiones, intentos de ingreso y tablets');
  const W = 270;
  poblar(lz, {
    USUARIO:       { x: 60,   y: 150, ancho: W },
    TIENDA:        { x: 800,  y: 150, ancho: W },
    SESION:        { x: 430,  y: 400, ancho: W },
    DISPOSITIVO:   { x: 800,  y: 400, ancho: W },
    INTENTO_LOGIN: { x: 1170, y: 150, ancho: W },
    SYNC_LOG:      { x: 1170, y: 400, ancho: W },
  }, {
    contexto: ['USUARIO', 'TIENDA'],
    orden: ['DISPOSITIVO>SYNC_LOG', 'DISPOSITIVO>SESION', 'TIENDA>DISPOSITIVO', 'USUARIO>SESION',
            'TIENDA>SESION', 'TIENDA>INTENTO_LOGIN'],
  });
  leyenda(lz, 60, 650, ['fuerte', 'contexto', 'rel']);
  lz.trazar();
  return entregar(lz, 'Vista de acceso y sincronizacion: cada sesion pertenece a un usuario, puede estar en un dispositivo y fija desde que tienda opera. Los intentos de ingreso se registran por tienda. Cada tablet deja una bitacora de sincronizacion.');
}

// =============================================================================
// Figuras de construcciones del modelo extendido (03 a 07)
// =============================================================================

/** Caja sencilla, sin lienzo: para las figuras chicas. */
function caja(x, y, ancho, nombre, atributos, tipo = 'fuerte', nota) {
  const lz = new Lienzo(4000, 4000);
  const c = lz.entidad(nombre, { x, y, ancho, tipo, atributos, nota });
  return { svg: lz.cuerpo.join('\n  '), ...c };
}

const envolver = (ancho, alto, aria, partes) => [
  `<svg class="dg" viewBox="0 0 ${ancho} ${alto}" role="img" aria-label="${aria}">`,
  '  <defs>',
  '    <marker id="mb" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">',
  '      <path d="M0,0 L10,5 L0,10 z" fill="var(--ambar)"/>',
  '    </marker>',
  '  </defs>',
  ...partes.flat().map((p) => '  ' + p),
  '</svg>',
].join('\n');

export function especializacion() {
  const p = caja(330, 30, 260, 'USUARIO',
    [pk('id'), a('nombre, activo'), a('rol (discriminante)')]);
  const ad = caja(80, 300, 300, 'ADMINISTRADOR',
    [a('email, password_hash'), d('sin filas en USUARIO_TIENDA'), d('ve las dos tiendas')]);
  const em = caja(540, 300, 300, 'EMPLEADO',
    [a('pin_hash'), d('una o mas filas en USUARIO_TIENDA'), d('opera la tienda de su sesion')]);
  const cx = 460, y0 = p.y + p.h, yc = y0 + 48, yt = yc + 24, yb = 270;
  return envolver(920, 470,
    'Especializacion total y disjunta de USUARIO en ADMINISTRADOR y EMPLEADO. Se implementa en una sola tabla con la columna rol como discriminante; la restriccion CK_USUARIO_CREDENCIALES exige las credenciales de cada subtipo.', [
      p.svg, ad.svg, em.svg,
      `<line class="rel-amb" x1="${cx - 3}" y1="${y0}" x2="${cx - 3}" y2="${yc - 16}"/>`,
      `<line class="rel-amb" x1="${cx + 3}" y1="${y0}" x2="${cx + 3}" y2="${yc - 16}"/>`,
      `<text class="verb" x="${cx + 28}" y="${yc - 4}">total: todo usuario es uno de los dos</text>`,
      `<text class="verb" x="${cx + 28}" y="${yc + 12}">disjunta: nunca los dos a la vez</text>`,
      `<circle class="circ-d" cx="${cx}" cy="${yc}" r="16"/>`,
      `<text class="card-amb" x="${cx}" y="${yc + 4}" text-anchor="middle">d</text>`,
      `<line class="rel-amb" x1="${cx}" y1="${yc + 16}" x2="${cx}" y2="${yt}"/>`,
      `<polygon class="tri-isa" points="${cx},${yt} ${cx - 30},${yt + 28} ${cx + 30},${yt + 28}"/>`,
      `<text class="card-amb" x="${cx}" y="${yt + 23}" text-anchor="middle">ISA</text>`,
      `<line class="rel-amb" x1="${cx}" y1="${yt + 28}" x2="${cx}" y2="${yb}"/>`,
      `<line class="rel-amb" x1="230" y1="${yb}" x2="690" y2="${yb}"/>`,
      `<line class="rel-amb" x1="230" y1="${yb}" x2="230" y2="300"/>`,
      `<line class="rel-amb" x1="690" y1="${yb}" x2="690" y2="300"/>`,
      `<text class="verb" x="460" y="450" text-anchor="middle">Una sola tabla Usuario: rol es el discriminante y CK_USUARIO_CREDENCIALES exige las credenciales de cada subtipo</text>`,
    ]);
}

export function entidadDebil() {
  const v = caja(40, 60, 220, 'VENTA', [pk('id'), a('numero'), a('total')]);
  const l = caja(700, 40, 260, 'VENTA_LINEA',
    [pk('venta_id + numero'), a('cantidad'), a('precio_unitario'), a('descuento'), a('subtotal')], 'debil');
  const my = 112;
  return envolver(1000, 290,
    'VENTA_LINEA es entidad debil: su clave es venta_id mas el numero de linea, y depende de VENTA por una relacion identificadora. Borrar la venta borra sus lineas.', [
      v.svg, l.svg,
      `<line class="rel-amb" x1="260" y1="${my}" x2="385" y2="${my}"/>`,
      `<polygon class="rombo-id" points="385,${my} 480,${my - 45} 575,${my} 480,${my + 45}"/>`,
      `<polygon fill="none" stroke="var(--ambar)" stroke-width="1" points="400,${my} 480,${my - 37} 560,${my} 480,${my + 37}"/>`,
      `<text class="verb" x="480" y="${my - 4}" text-anchor="middle">DETALLA</text>`,
      `<text class="card-amb" x="480" y="${my + 14}" text-anchor="middle">1 : N</text>`,
      `<line class="rel-amb" x1="575" y1="${my}" x2="700" y2="${my}" marker-end="url(#mb)"/>`,
      `<text class="verb" x="150" y="230" text-anchor="middle">entidad fuerte</text>`,
      `<text class="verb" x="480" y="230" text-anchor="middle">relación identificadora</text>`,
      `<text class="verb" x="830" y="230" text-anchor="middle">entidad débil</text>`,
      `<text class="verb" x="500" y="268" text-anchor="middle">borrar la venta borra sus líneas — ON DELETE CASCADE</text>`,
    ]);
}

export function relacionRecursiva() {
  const c = caja(60, 110, 240, 'CATEGORIA', [pk('id'), a('nombre'), a('padre_id (FK)')]);
  return envolver(520, 300,
    'CATEGORIA se relaciona consigo misma: una categoria puede contener otras, y padre_id apunta a la que la contiene.', [
      c.svg,
      `<path class="rel-amb" d="M300,160 H410 V50 H180 V110" marker-end="url(#mb)"/>`,
      `<polygon class="rombo" points="410,62 450,95 410,128 370,95"/>`,
      `<text class="verb" x="410" y="99" text-anchor="middle">contiene</text>`,
      `<text class="card-amb" x="316" y="152">0..1</text>`,
      `<text class="card-amb" x="190" y="100">N</text>`,
      `<text class="verb" x="270" y="270" text-anchor="middle">Plomería contiene Tuberías PVC · padre_id NULL = primer nivel</text>`,
    ]);
}

export function entidadAsociativa() {
  const fila = (y, izq, der, rombo, card1, card2, attrs) => {
    const i = caja(40, y, 220, izq, [a('id (PK)')], 'contexto');
    const dd = caja(700, y, 220, der, [a('id (PK)')], 'contexto');
    const my = y + 40;
    const partes = [i.svg, dd.svg,
      `<line class="rel-amb" x1="260" y1="${my}" x2="375" y2="${my}"/>`,
      `<line class="rel-amb" x1="585" y1="${my}" x2="700" y2="${my}"/>`,
      `<polygon class="rombo-id" points="375,${my} 480,${my - 40} 585,${my} 480,${my + 40}"/>`,
      `<rect fill="none" stroke="var(--ambar)" stroke-width="1.2" x="365" y="${my - 48}" width="230" height="96"/>`,
      `<text class="verb" x="480" y="${my + 4}" text-anchor="middle">${rombo}</text>`,
      `<text class="card-amb" x="300" y="${my - 8}">${card1}</text>`,
      `<text class="card-amb" x="640" y="${my - 8}">${card2}</text>`,
    ];
    attrs.forEach(([t, der], k) => {
      const ex = 380 + k * 200, ey = my + 100;
      partes.push(`<line class="rel-amb" x1="480" y1="${my + 48}" x2="${ex}" y2="${ey - 18}"/>`);
      partes.push(`<ellipse class="${der ? 'elip-der' : 'elip'}" cx="${ex}" cy="${ey}" rx="95" ry="18"/>`);
      partes.push(`<text class="${der ? 'der' : 'atr'}" x="${ex}" y="${ey + 4}" text-anchor="middle">${t}</text>`);
    });
    return partes;
  };
  return envolver(960, 560,
    'Entidades asociativas: STOCK resuelve la relacion muchos a muchos entre tienda y producto, con la cantidad derivada y el minimo como atributos propios; USUARIO_TIENDA resuelve la de usuario y tienda.', [
      fila(30, 'TIENDA', 'PRODUCTO', 'STOCK', 'M', 'N', [['cantidad', true], ['cantidad_minima', false]]),
      fila(300, 'USUARIO', 'TIENDA', 'USUARIO_TIENDA', 'M', 'N', [['created_at', false]]),
    ]);
}

export function atributosDerivados() {
  const movs = [['entrada', '+1500'], ['venta', '−50'], ['venta (sin conexión)', '−8'],
                ['merma', '−2'], ['ajuste (conteo físico)', '+2']];
  const partes = [
    `<rect class="fondo-z" x="20" y="20" width="380" height="290"/>`,
    `<text class="zona" x="36" y="44">MOVIMIENTO_INVENTARIO</text>`,
  ];
  movs.forEach(([t, n], k) => {
    const y = 60 + k * 48;
    partes.push(`<rect class="ent" x="44" y="${y}" width="332" height="34"/>`);
    partes.push(`<text class="atr" x="60" y="${y + 21}">${t}</text>`);
    partes.push(`<text class="card" x="360" y="${y + 21}" text-anchor="end">${n}</text>`);
  });
  partes.push(
    `<line stroke="var(--verde)" stroke-width="1.5" x1="400" y1="165" x2="480" y2="165"/>`,
    `<circle fill="var(--verde-tenue)" stroke="var(--verde)" stroke-width="1.5" cx="510" cy="165" r="30"/>`,
    `<text class="titulo" x="510" y="175" text-anchor="middle" font-size="24" fill="var(--verde)">Σ</text>`,
    `<line stroke="var(--verde)" stroke-width="1.5" x1="540" y1="165" x2="640" y2="165"/>`,
    `<ellipse class="elip-der" cx="790" cy="165" rx="145" ry="38"/>`,
    `<text class="der" x="790" y="160" text-anchor="middle">Stock.cantidad</text>`,
    `<text class="der" x="790" y="178" text-anchor="middle">= 1442</text>`,
    `<text class="verb" x="790" y="232" text-anchor="middle">atributo derivado</text>`,
    `<text class="verb" x="790" y="250" text-anchor="middle">lo mantiene un disparador para consultar rápido</text>`,
    `<text class="verb" x="790" y="268" text-anchor="middle">la verdad sigue siendo la suma de movimientos</text>`,

    `<rect class="fondo-z" x="20" y="340" width="380" height="150"/>`,
    `<text class="zona" x="36" y="364">VENTA (a crédito) y PAGO_CREDITO</text>`,
    `<rect class="ent" x="44" y="380" width="332" height="34"/>`,
    `<text class="atr" x="60" y="401">ventas fiadas, no anuladas</text>`,
    `<text class="card" x="360" y="401" text-anchor="end">+820</text>`,
    `<rect class="ent" x="44" y="428" width="332" height="34"/>`,
    `<text class="atr" x="60" y="449">abonos del cliente</text>`,
    `<text class="card" x="360" y="449" text-anchor="end">−300</text>`,
    `<line stroke="var(--verde)" stroke-width="1.5" x1="400" y1="415" x2="480" y2="415"/>`,
    `<circle fill="var(--verde-tenue)" stroke="var(--verde)" stroke-width="1.5" cx="510" cy="415" r="30"/>`,
    `<text class="titulo" x="510" y="425" text-anchor="middle" font-size="24" fill="var(--verde)">Σ</text>`,
    `<line stroke="var(--verde)" stroke-width="1.5" x1="540" y1="415" x2="640" y2="415"/>`,
    `<ellipse class="elip-der" cx="790" cy="415" rx="145" ry="38"/>`,
    `<text class="der" x="790" y="410" text-anchor="middle">CLIENTE.saldo</text>`,
    `<text class="der" x="790" y="428" text-anchor="middle">= 520</text>`,
    `<text class="verb" x="790" y="476" text-anchor="middle">no se guarda: lo calcula v_cuentas_por_cobrar</text>`,
  );
  return envolver(960, 510,
    'Atributos derivados: el stock es la suma de los movimientos de inventario, y el saldo de un cliente es lo fiado menos lo abonado. Ninguno de los dos se escribe a mano.', partes);
}

export { anchoTexto };
