// =============================================================================
// Verifica los SVG generados.
//
// Comprueba que no queden restos del documento web (clases, variables CSS),
// que ningun elemento tenga atributos duplicados -- error facil de introducir
// al convertir clases en atributos -- y que en cada vista del MER las cajas
// no se pisen, ningun conector atraviese una entidad y ningun rotulo quede
// encima de una linea.
//
// Solo revisa los archivos generados (los que empiezan con dos digitos).
// "modelo relacional 2.svg" es una exportacion de Lucidchart y no sale de aca.
// =============================================================================

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const aqui = dirname(fileURLToPath(import.meta.url));
const archivos = readdirSync(aqui).filter((f) => /^\d\d-.*\.svg$/.test(f)).sort();

let fallos = 0;
const mal = (m) => { console.log(`  FALLA ${m}`); fallos++; };
const bien = (m) => console.log(`  OK    ${m}`);

console.log('=== Comprobaciones por archivo ===\n');

for (const archivo of archivos) {
  const svg = readFileSync(join(aqui, archivo), 'utf8');
  const problemas = [];

  if (/class="/.test(svg))            problemas.push('quedan atributos class');
  if (/var\(--/.test(svg))            problemas.push('quedan variables CSS sin resolver');

  // Entidades con nombre de HTML. XML solo predefine cinco; el resto hace
  // fallar el analisis de un SVG suelto aunque el navegador lo tolere dentro
  // de una pagina HTML.
  const entidades = [...new Set((svg.match(/&[a-zA-Z][a-zA-Z0-9]*;/g) ?? [])
    .filter((e) => !['&amp;', '&lt;', '&gt;', '&quot;', '&apos;'].includes(e)))];
  if (entidades.length) {
    problemas.push(`entidades no validas en XML: ${entidades.join(', ')}`);
  }
  if (!/xmlns="http/.test(svg))       problemas.push('falta el xmlns');
  if (!/<title>/.test(svg))           problemas.push('falta el titulo accesible');
  if (!/aria-label=/.test(svg))       problemas.push('falta aria-label');
  // resvg -- el que rasteriza para el Word -- no entiende el valor de SVG 2
  // 'auto-start-reverse' y deja todas las flechas apuntando a la derecha: las
  // que llegan desde arriba o desde la derecha quedan tapadas por la caja.
  if (/auto-start-reverse/.test(svg)) problemas.push('marcador con orient="auto-start-reverse"');

  // Atributos duplicados dentro de una misma etiqueta: XML invalido.
  for (const etiqueta of svg.match(/<\w+[^>]*>/g) ?? []) {
    const nombres = [...etiqueta.matchAll(/\s([\w:-]+)=/g)].map((m) => m[1]);
    const repetidos = nombres.filter((n, i) => nombres.indexOf(n) !== i);
    if (repetidos.length) {
      problemas.push(`atributo duplicado (${[...new Set(repetidos)].join(', ')}) en ${etiqueta.slice(0, 46)}...`);
      break;
    }
  }

  // Etiquetas abiertas y cerradas emparejadas.
  const pila = [];
  for (const t of svg.match(/<\/?[\w:-]+[^>]*?\/?>/g) ?? []) {
    if (t.startsWith('<?') || t.endsWith('/>')) continue;
    if (t.startsWith('</')) {
      const nombre = t.slice(2, -1).trim();
      if (pila.pop() !== nombre) { problemas.push(`cierre desemparejado en </${nombre}>`); break; }
    } else {
      pila.push(t.slice(1).split(/[\s>]/)[0]);
    }
  }
  if (pila.length) problemas.push(`quedan ${pila.length} etiquetas sin cerrar: ${pila.join(', ')}`);

  if (problemas.length) { problemas.forEach((p) => mal(`${archivo}: ${p}`)); }
  else bien(archivo);
}

// -----------------------------------------------------------------------------
// Geometria de las vistas del MER
// -----------------------------------------------------------------------------

/** Lee los atributos de una etiqueta sin depender del orden en que aparecen. */
function atributos(etiqueta) {
  return Object.fromEntries(
    [...etiqueta.matchAll(/\s([\w:-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
}

/** Convierte un path ortogonal (M/H/V) en una lista de segmentos. */
function segmentosDePath(d) {
  const segs = [];
  let x = 0, y = 0;
  for (const [, cmd, args] of d.matchAll(/([MHV])\s*([-\d.,\s]+)/g)) {
    const n = args.trim().split(/[,\s]+/).map(Number);
    if (cmd === 'M') { [x, y] = n; }
    else if (cmd === 'H') { segs.push([x, y, n[0], y]); x = n[0]; }
    else if (cmd === 'V') { segs.push([x, y, x, n[0]]); y = n[0]; }
  }
  return segs;
}

const sinEntidades = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

function revisarGeometria(archivo) {
  console.log(`\n=== Geometria de ${archivo} ===\n`);
  const svg = readFileSync(join(aqui, archivo), 'utf8');
  const rects = (svg.match(/<rect[^>]*>/g) ?? []).map((e) => atributos(e)).filter((a) => a.stroke);
  const comoCaja = (a) => ({ x: +a.x, y: +a.y, w: +a.width, h: +a.height });

  // Cajas de entidad: los cuerpos (mas de 30 de alto). Las cabeceras (24-26)
  // se revisan aparte para los conectores. El rectangulo interior de las
  // entidades debiles cae entero dentro de su caja y se reconoce como anidado.
  const cajas = rects.filter((a) => +a.height > 30 && +a.width < 1000).map(comoCaja);
  const cabeceras = rects.filter((a) => +a.height >= 24 && +a.height <= 30).map(comoCaja);
  console.log(`  cajas detectadas: ${cajas.length}`);

  const dentro = (p, q) => p.x >= q.x && p.y >= q.y && p.x + p.w <= q.x + q.w && p.y + p.h <= q.y + q.h;
  const pisa = (p, q) => p.x < q.x + q.w && p.x + p.w > q.x && p.y < q.y + q.h && p.y + p.h > q.y;

  let choques = 0;
  for (let i = 0; i < cajas.length; i++) {
    for (let j = i + 1; j < cajas.length; j++) {
      const a = cajas[i], b = cajas[j];
      if (pisa(a, b) && !dentro(a, b) && !dentro(b, a)) {
        mal(`cajas superpuestas: (${a.x},${a.y},${a.w}x${a.h}) con (${b.x},${b.y},${b.w}x${b.h})`);
        choques++;
      }
    }
  }
  if (!choques) bien('ninguna caja de entidad se superpone con otra');

  const [, vw, vh] = svg.match(/viewBox="0 0 (\d+) (\d+)"/).map(Number);
  const fuera = cajas.filter((c) => c.x < 0 || c.y < 0 || c.x + c.w > vw || c.y + c.h > vh);
  if (fuera.length) mal(`${fuera.length} cajas se salen del viewBox`);
  else bien(`todas las cajas caben en el viewBox (${vw}x${vh})`);

  // Ningun conector puede atravesar una entidad: una linea que pasa por encima
  // de una caja parece unirse a ella. Tocar el borde es legitimo.
  const conectores = [];
  for (const etiqueta of svg.match(/<path[^>]*>/g) ?? []) {
    const a = atributos(etiqueta);
    if (a.d && !/z/i.test(a.d)) conectores.push(...segmentosDePath(a.d));
  }
  for (const etiqueta of svg.match(/<line[^>]*>/g) ?? []) {
    const a = atributos(etiqueta);
    // El separador de la leyenda es gris claro: no es un conector.
    if (a.x1 !== undefined && a.stroke !== '#C9D2DA') conectores.push([+a.x1, +a.y1, +a.x2, +a.y2]);
  }
  const M = 3;
  let atraviesan = 0;
  for (const [x1, y1, x2, y2] of conectores) {
    const sx0 = Math.min(x1, x2), sx1 = Math.max(x1, x2);
    const sy0 = Math.min(y1, y2), sy1 = Math.max(y1, y2);
    for (const c of [...cajas, ...cabeceras]) {
      if (sx0 < c.x + c.w - M && sx1 > c.x + M && sy0 < c.y + c.h - M && sy1 > c.y + M) {
        mal(`el segmento (${x1},${y1})-(${x2},${y2}) atraviesa la caja (${c.x},${c.y},${c.w}x${c.h})`);
        atraviesan++;
      }
    }
  }
  console.log(`  segmentos analizados: ${conectores.length}`);
  if (!atraviesan) bien('ningun conector atraviesa una caja de entidad');

  // Rotulos: un texto fuera de las cajas no puede quedar encima de una linea,
  // de otro texto ni a medias sobre una caja. El ancho se estima a partir del
  // tamanio y la familia; es el fallo que no se ve leyendo el codigo.
  const textos = [...svg.matchAll(/<text([^>]*)>([^<]*)<\/text>/g)].map(([, at, contenido]) => {
    const a = atributos(at);
    const tam = +(a['font-size'] ?? 12);
    const mono = /Mono|Consolas/.test(a['font-family'] ?? '');
    const w = sinEntidades(contenido).length * tam * (mono ? 0.6 : 0.52);
    let x = +a.x;
    if (a['text-anchor'] === 'middle') x -= w / 2;
    if (a['text-anchor'] === 'end') x -= w;
    return { x, y: +a.y - tam * 0.75, w, h: tam * 0.95, t: sinEntidades(contenido) };
  });
  const fueraLienzo = textos.filter((t) => t.x < 0 || t.y < 0 || t.x + t.w > vw || t.y + t.h > vh);
  if (fueraLienzo.length) mal(`textos fuera del lienzo: ${fueraLienzo.map((t) => t.t).join(', ')}`);
  else bien(`los ${textos.length} textos caen dentro del lienzo`);

  const todas = [...cajas, ...cabeceras];
  const sueltos = textos.filter((t) => !todas.some((c) => dentro(t, c)));
  const corta = (t, [x1, y1, x2, y2]) => Math.min(x1, x2) < t.x + t.w && Math.max(x1, x2) > t.x &&
                                           Math.min(y1, y2) < t.y + t.h && Math.max(y1, y2) > t.y;
  let malos = 0;
  for (const t of sueltos) {
    // Los simbolos de la jerarquia (d, ISA) van a proposito sobre su linea.
    if (/^(d|ISA)$/.test(t.t)) continue;
    if (conectores.some((s) => corta(t, s))) { mal(`el texto "${t.t}" queda encima de una linea`); malos++; continue; }
    if (todas.some((c) => pisa(t, c))) { mal(`el texto "${t.t}" queda a medias sobre una caja`); malos++; }
  }
  for (let i = 0; i < sueltos.length; i++) {
    for (let j = i + 1; j < sueltos.length; j++) {
      if (pisa(sueltos[i], sueltos[j])) {
        mal(`los textos "${sueltos[i].t}" y "${sueltos[j].t}" se pisan`);
        malos++;
      }
    }
  }
  if (!malos) bien(`los ${sueltos.length} rotulos sueltos no pisan lineas, cajas ni otros rotulos`);
}

for (const archivo of ['00-modelo-completo.svg', '01-vista-estructura.svg',
                       '02-vista-operacion.svg', '09-vista-acceso.svg']) {
  revisarGeometria(archivo);
}

console.log('');
console.log('='.repeat(46));
console.log(fallos === 0 ? 'Sin fallos.' : `${fallos} fallos.`);
console.log('='.repeat(46));

process.exit(fallos === 0 ? 0 : 1);
