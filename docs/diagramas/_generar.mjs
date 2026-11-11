// =============================================================================
// Genera los diagramas del MER como archivos SVG sueltos y autocontenidos.
//
// Las figuras se describen con clases (ent, rel, card...) en _figuras.mjs, y
// el proceso de venta en _fuente-proceso-venta.svgsrc. Este script convierte
// cada clase en atributos de presentacion (fill, stroke, font-family...), que
// es lo que entienden PowerPoint, Google Slides, Word, Inkscape e Illustrator.
//
// Uso:  node docs/diagramas/_generar.mjs
// =============================================================================

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as F from './_figuras.mjs';

const aqui = dirname(fileURLToPath(import.meta.url));

// Paleta resuelta en tema claro. Los SVG sueltos se usan para imprimir y para
// diapositivas, asi que se fijan los colores del tema claro sobre fondo blanco.
const C = {
  papel:      '#F1F3F5',
  papelAlto:  '#FFFFFF',
  papelHund:  '#E7EBEF',
  tinta:      '#12181F',
  tintaMed:   '#3D4954',
  tintaBaja:  '#66727E',
  linea:      '#C9D2DA',
  azul:       '#1F5673',
  azulTenue:  '#E2EDF3',
  ambar:      '#A8551F',
  ambarTenue: '#F6E8DC',
  verde:      '#2F6B4F',
  verdeTenue: '#E1EFE7',
};

const F_DISPLAY = "'IBM Plex Sans Condensed','Arial Narrow','Segoe UI',sans-serif";
const F_MONO    = "'IBM Plex Mono','Consolas','Courier New',monospace";

// Traduccion de cada clase a sus atributos de presentacion.
const CLASES = {
  'ent':         { fill: C.papelAlto, stroke: C.azul, 'stroke-width': '1.6' },
  'ent-ctx':     { fill: C.papelHund, stroke: C.tintaBaja, 'stroke-width': '1.3', 'stroke-dasharray': '5 3' },
  'ent-deb':     { fill: C.papelAlto, stroke: C.ambar, 'stroke-width': '1.6' },
  'ent-deb-int': { fill: 'none', stroke: C.ambar, 'stroke-width': '1' },
  'ent-aso':     { fill: C.ambarTenue, stroke: C.ambar, 'stroke-width': '1.6' },
  'cab-ent':     { fill: C.azulTenue, stroke: C.azul, 'stroke-width': '1.6' },
  'cab-deb':     { fill: C.ambarTenue, stroke: C.ambar, 'stroke-width': '1.6' },
  'cab-ctx':     { fill: 'none', stroke: C.tintaBaja, 'stroke-width': '1.3', 'stroke-dasharray': '5 3' },

  'nom':      { 'font-family': F_DISPLAY, 'font-weight': '700', 'font-size': '14', fill: C.tinta, 'letter-spacing': '0.6' },
  'nom-ctx':  { 'font-family': F_DISPLAY, 'font-weight': '600', 'font-size': '13', fill: C.tintaBaja, 'letter-spacing': '0.6' },
  'atr':      { 'font-family': F_MONO, 'font-size': '11', fill: C.tintaMed },
  'pk':       { 'font-family': F_MONO, 'font-size': '11', fill: C.tinta, 'font-weight': '600', 'text-decoration': 'underline' },
  'der':      { 'font-family': F_MONO, 'font-size': '11', fill: C.verde, 'font-style': 'italic' },
  'card':     { 'font-family': F_MONO, 'font-size': '11', 'font-weight': '600', fill: C.azul },
  'card-amb': { 'font-family': F_MONO, 'font-size': '11', 'font-weight': '600', fill: C.ambar },
  'verb':     { 'font-family': F_DISPLAY, 'font-size': '11.5', 'font-weight': '500', fill: C.tintaBaja },
  'zona':     { 'font-family': F_MONO, 'font-size': '10.5', fill: C.tintaBaja, 'letter-spacing': '1' },
  'leg':      { 'font-family': F_DISPLAY, 'font-size': '12.5', 'font-weight': '500', fill: C.tintaMed },
  'titulo':   { 'font-family': F_DISPLAY, 'font-size': '28', 'font-weight': '700', fill: C.tinta, 'letter-spacing': '0.8' },
  'subtitulo':{ 'font-family': F_DISPLAY, 'font-size': '16', 'font-weight': '500', fill: C.tintaMed },

  'rel':      { stroke: C.azul, 'stroke-width': '1.4', fill: 'none' },
  'rel-amb':  { stroke: C.ambar, 'stroke-width': '1.6', fill: 'none' },
  'rel-ctx':  { stroke: C.tintaBaja, 'stroke-width': '1.2', fill: 'none', 'stroke-dasharray': '4 3' },
  'sep':      { stroke: C.linea, 'stroke-width': '1' },

  'rombo':    { fill: C.papelAlto, stroke: C.azul, 'stroke-width': '1.5' },
  'rombo-id': { fill: C.ambarTenue, stroke: C.ambar, 'stroke-width': '1.5' },
  'circ-d':   { fill: C.ambarTenue, stroke: C.ambar, 'stroke-width': '1.5' },
  'tri-isa':  { fill: C.ambarTenue, stroke: C.ambar, 'stroke-width': '1.5' },
  'elip':     { fill: C.papelAlto, stroke: C.azul, 'stroke-width': '1.3' },
  'elip-der': { fill: C.verdeTenue, stroke: C.verde, 'stroke-width': '1.3', 'stroke-dasharray': '5 3' },
  'fondo-z':  { fill: C.papelHund, stroke: C.linea, 'stroke-width': '1' },

  // Diagrama del proceso de venta
  'paso':      { fill: C.papelHund, stroke: C.tintaBaja, 'stroke-width': '1.3' },
  'paso-nada': { fill: 'none', stroke: C.tintaBaja, 'stroke-width': '1.2', 'stroke-dasharray': '4 3' },
  'flujo':     { stroke: C.tintaBaja, 'stroke-width': '1.4', fill: 'none' },
  'escribe':   { stroke: C.azul, 'stroke-width': '1.4', fill: 'none', 'stroke-dasharray': '5 4' },
  'rotulo-p':  { 'font-family': F_DISPLAY, 'font-weight': '600', 'font-size': '13', fill: C.tinta },
};

const VARS = {
  '--papel': C.papel, '--papel-alto': C.papelAlto, '--papel-hund': C.papelHund,
  '--tinta': C.tinta, '--tinta-med': C.tintaMed, '--tinta-baja': C.tintaBaja,
  '--linea': C.linea, '--azul': C.azul, '--azul-tenue': C.azulTenue,
  '--ambar': C.ambar, '--ambar-tenue': C.ambarTenue,
  '--verde': C.verde, '--verde-tenue': C.verdeTenue,
};

/** Sustituye class="x" por los atributos equivalentes, sin duplicar los que ya estan. */
function aplicarClases(svg) {
  return svg.replace(/<(\w+)([^>]*?)class="([^"]+)"([^>]*?)>/g, (todo, tag, antes, clase, despues) => {
    const nombres = clase.split(/\s+/).filter((n) => n !== 'dg');
    const attrs = {};
    for (const n of nombres) Object.assign(attrs, CLASES[n] ?? {});

    // Si el elemento ya declara el atributo a mano, ese gana: no se duplica.
    const resto = antes + despues;
    const texto = Object.entries(attrs)
      .filter(([k]) => !new RegExp(`\\s${k}=`).test(resto))
      .map(([k, v]) => `${k}="${v}"`)
      .join(' ');

    return `<${tag}${antes}${texto ? ' ' + texto : ''}${despues}>`.replace(/\s+/g, ' ').replace(/ >/, '>').replace(/ \/>/, '/>');
  });
}

/** Reemplaza las var(--x) que quedan sueltas en atributos (marcadores, etc.). */
function resolverVars(svg) {
  return svg.replace(/var\((--[a-z-]+)\)/g, (todo, v) => VARS[v] ?? todo);
}

/**
 * Sustituye las entidades con nombre de HTML por su caracter Unicode.
 *
 * XML solo predefine cinco entidades: amp, lt, gt, quot y apos. Las demas
 * -- &mdash;, &rarr;, &minus;... -- funcionan dentro de una pagina HTML pero
 * hacen fallar el analisis de un SVG suelto, que es XML estricto. El navegador
 * las toleraba porque el SVG venia incrustado en HTML; Inkscape, Illustrator y
 * cualquier rasterizador rechazan el archivo.
 *
 * Se emite el caracter literal, que en UTF-8 es portable a todas partes.
 */
const ENTIDADES = {
  '&mdash;': '—', '&ndash;': '–', '&minus;': '−',
  '&rarr;': '→',  '&larr;': '←',  '&harr;': '↔',
  '&Sigma;': 'Σ', '&hellip;': '…', '&nbsp;': ' ',
  '&laquo;': '«', '&raquo;': '»', '&times;': '×',
  '&le;': '≤',    '&ge;': '≥',    '&deg;': '°',
};
const XML_PREDEFINIDAS = ['&amp;', '&lt;', '&gt;', '&quot;', '&apos;'];

function resolverEntidades(svg) {
  return svg.replace(/&[a-zA-Z][a-zA-Z0-9]*;/g, (e) => {
    if (XML_PREDEFINIDAS.includes(e)) return e;
    const caracter = ENTIDADES[e];
    if (!caracter) throw new Error(`Entidad sin equivalente para un SVG suelto: ${e}`);
    return caracter;
  });
}

/** Envuelve el SVG para que funcione como archivo independiente. */
function empaquetar(svg, titulo) {
  const vb = svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/);
  const [, w, h] = vb;

  let salida = svg
    .replace(/<svg /, `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" `)
    .replace(/\sclass="dg"/, '');

  // Fondo blanco explicito: sin el, el SVG es transparente y el texto oscuro
  // desaparece al pegarlo sobre una diapositiva de fondo oscuro.
  const fondo = `\n  <title>${titulo}</title>\n  <rect x="0" y="0" width="${w}" height="${h}" fill="${C.papelAlto}"/>`;
  salida = salida.replace(/(<svg[^>]*>)/, `$1${fondo}`);

  return resolverEntidades(salida.trimStart()) + '\n';
}

// -----------------------------------------------------------------------------
const FIGURAS = [
  ['00-modelo-completo',         'Modelo E-R extendido completo',                       F.modeloCompleto],
  ['01-vista-estructura',        'Vista de estructura: negocio, catalogo y personas',   F.vistaEstructura],
  ['02-vista-operacion',         'Vista de operacion: ventas, caja, credito e inventario', F.vistaOperacion],
  ['03-especializacion-usuario', 'Especializacion total y disjunta de USUARIO',          F.especializacion],
  ['04-entidad-debil',           'Entidad debil VENTA_LINEA y relacion identificadora',  F.entidadDebil],
  ['05-relacion-recursiva',      'Relacion recursiva de CATEGORIA',                      F.relacionRecursiva],
  ['06-entidad-asociativa',      'Entidades asociativas STOCK y USUARIO_TIENDA',         F.entidadAsociativa],
  ['07-atributos-derivados',     'Atributos derivados: stock y saldo del cliente',       F.atributosDerivados],
  ['08-proceso-venta',           'El proceso de venta sobre el modelo de datos',
    () => readFileSync(join(aqui, '_fuente-proceso-venta.svgsrc'), 'utf8').trim()],
  ['09-vista-acceso',            'Vista de acceso y sincronizacion',                     F.vistaAcceso],
  ['10-modelo-relacional',       'Modelo relacional leido de db/schema.sql',             F.modeloRelacional],
];

// Antes de dibujar: el MER tiene que tener las mismas tablas y claves foraneas
// que el esquema. Si no coinciden, ningun diagrama se escribe.
const diferencias = F.compararConEsquema();
if (diferencias.length) {
  console.error('El MER no coincide con db/schema.sql:\n  ' + diferencias.join('\n  '));
  process.exit(1);
}

const generados = [];
for (const [nombre, titulo, construir] of FIGURAS) {
  const svg = empaquetar(resolverVars(aplicarClases(construir())), titulo);
  const archivo = `${nombre}.svg`;
  writeFileSync(join(aqui, archivo), svg, 'utf8');
  generados.push([archivo, svg.length]);
}

console.log('SVG generados en docs/diagramas/\n');
for (const [archivo, bytes] of generados) {
  console.log(`  ${archivo.padEnd(34)} ${(bytes / 1024).toFixed(1).padStart(6)} KB`);
}
console.log(`\n${generados.length} archivos.`);
