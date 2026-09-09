// =============================================================================
// Verifica los SVG generados.
//
// Comprueba que no queden restos del documento web (clases, variables CSS),
// que ningun elemento tenga atributos duplicados -- error facil de introducir
// al convertir clases en atributos -- y que en el diagrama maestro las cajas
// de entidad no se pisen entre si.
// =============================================================================

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const aqui = dirname(fileURLToPath(import.meta.url));
const archivos = readdirSync(aqui).filter((f) => f.endsWith('.svg')).sort();

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
  // de una pagina HTML. Es el fallo que dejaba los archivos inservibles en
  // Inkscape, Illustrator y cualquier rasterizador.
  const entidades = [...new Set((svg.match(/&[a-zA-Z][a-zA-Z0-9]*;/g) ?? [])
    .filter((e) => !['&amp;', '&lt;', '&gt;', '&quot;', '&apos;'].includes(e)))];
  if (entidades.length) {
    problemas.push(`entidades no validas en XML: ${entidades.join(', ')}`);
  }
  if (!/xmlns="http/.test(svg))       problemas.push('falta el xmlns');
  if (!/<title>/.test(svg))           problemas.push('falta el titulo accesible');
  if (!/aria-label=/.test(svg))       problemas.push('falta aria-label');

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
console.log('\n=== Geometria del diagrama maestro ===\n');

const maestro = readFileSync(join(aqui, '00-modelo-completo.svg'), 'utf8');

/** Lee los atributos de una etiqueta sin depender del orden en que aparecen. */
function atributos(etiqueta) {
  return Object.fromEntries(
    [...etiqueta.matchAll(/\s([\w:-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
}

// Cajas de entidad: las de cuerpo, no las cabeceras (altura 24-26), ni el
// rectangulo interior de las entidades debiles (grosor 1), ni el fondo blanco.
const cajas = (maestro.match(/<rect[^>]*>/g) ?? [])
  .map((etiqueta) => atributos(etiqueta))
  .filter((a) => a.stroke && +a.height > 30 && +a.width < 1000)
  .map((a) => ({ x: +a.x, y: +a.y, w: +a.width, h: +a.height }));

console.log(`  cajas detectadas: ${cajas.length}`);

let choques = 0;
for (let i = 0; i < cajas.length; i++) {
  for (let j = i + 1; j < cajas.length; j++) {
    const a = cajas[i], b = cajas[j];
    const solapa = a.x < b.x + b.w && a.x + a.w > b.x &&
                   a.y < b.y + b.h && a.y + a.h > b.y;
    // Cabecera y cuerpo de una misma entidad comparten borde: no es solape real.
    const contiguas = (a.x === b.x && a.w === b.w) &&
                      (Math.abs(a.y + a.h - b.y) < 2 || Math.abs(b.y + b.h - a.y) < 2);
    // Una caja contenida por completo en otra es el doble borde de una entidad
    // debil, que es notacion deliberada y no una colision.
    const dentro = (p, q) => p.x >= q.x && p.y >= q.y &&
                             p.x + p.w <= q.x + q.w && p.y + p.h <= q.y + q.h;
    const anidadas = dentro(a, b) || dentro(b, a);
    if (solapa && !contiguas && !anidadas) {
      mal(`cajas superpuestas: (${a.x},${a.y},${a.w}x${a.h}) con (${b.x},${b.y},${b.w}x${b.h})`);
      choques++;
    }
  }
}
if (!choques) bien('ninguna caja de entidad se superpone con otra');

// Todo el contenido dibujado debe caber dentro del viewBox.
const [, vw, vh] = maestro.match(/viewBox="0 0 (\d+) (\d+)"/).map(Number);
const fuera = cajas.filter((c) => c.x < 0 || c.y < 0 || c.x + c.w > vw || c.y + c.h > vh);
if (fuera.length) mal(`${fuera.length} cajas se salen del viewBox`);
else bien(`todas las cajas caben en el viewBox (${vw}x${vh})`);

// Ningun texto debe quedar fuera del lienzo.
const textos = [...maestro.matchAll(/<text[^>]*\sx="(-?[\d.]+)"[^>]*\sy="(-?[\d.]+)"/g)]
  .map((m) => ({ x: +m[1], y: +m[2] }));
const textoFuera = textos.filter((t) => t.x < 0 || t.y < 0 || t.x > vw || t.y > vh);
if (textoFuera.length) mal(`${textoFuera.length} textos fuera del lienzo`);
else bien(`los ${textos.length} textos caen dentro del lienzo`);

// -----------------------------------------------------------------------------
// Ninguna linea de relacion debe atravesar una caja de entidad.
//
// Es el fallo de legibilidad mas grave y el mas dificil de ver revisando el
// codigo: un conector que pasa por encima de una entidad parece unirse a ella.
// Tocar el borde es legitimo (ahi terminan los conectores); atravesar el
// interior, no.
// -----------------------------------------------------------------------------
console.log('\n=== Trazado de los conectores ===\n');

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

const conectores = [];
for (const etiqueta of maestro.match(/<path[^>]*>/g) ?? []) {
  const a = atributos(etiqueta);
  if (a.d) conectores.push(...segmentosDePath(a.d));
}
for (const etiqueta of maestro.match(/<line[^>]*>/g) ?? []) {
  const a = atributos(etiqueta);
  if (a.x1 !== undefined) conectores.push([+a.x1, +a.y1, +a.x2, +a.y2]);
}

const M = 3; // margen: tocar el borde no cuenta como atravesar
let atraviesan = 0;
for (const [x1, y1, x2, y2] of conectores) {
  const sx0 = Math.min(x1, x2), sx1 = Math.max(x1, x2);
  const sy0 = Math.min(y1, y2), sy1 = Math.max(y1, y2);
  for (const c of cajas) {
    const cruza = sx0 < c.x + c.w - M && sx1 > c.x + M &&
                  sy0 < c.y + c.h - M && sy1 > c.y + M;
    if (cruza) {
      mal(`el segmento (${x1},${y1})-(${x2},${y2}) atraviesa la caja (${c.x},${c.y},${c.w}x${c.h})`);
      atraviesan++;
    }
  }
}
console.log(`  segmentos analizados: ${conectores.length}`);
if (!atraviesan) bien('ningun conector atraviesa una caja de entidad');

console.log('');
console.log('='.repeat(46));
console.log(fallos === 0 ? 'Sin fallos.' : `${fallos} fallos.`);
console.log('='.repeat(46));

process.exit(fallos === 0 ? 0 : 1);
