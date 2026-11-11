// =============================================================================
// Genera el documento Word del proyecto Ferreplast.
//
// Los diagramas son SVG y Word no los inserta bien, asi que se rasterizan a PNG
// con resvg antes de incrustarlos. Las figuras van en paginas apaisadas: a lo
// ancho de una pagina vertical el texto de los diagramas quedaria ilegible.
//
// Uso:  npm run word      (o: node docs/word/construir.mjs, desde donde sea)
//
// Las cifras que se repiten en el texto (pruebas, endpoints, entidades) estan
// juntas en CIFRAS, mas abajo. Al cambiar el modelo o agregar pruebas se
// actualizan ahi y en ningun otro lado.
// =============================================================================

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
  Table, TableRow, TableCell, WidthType, ShadingType, BorderStyle,
  ImageRun, PageBreak, PageOrientation, LevelFormat, convertInchesToTwip,
} from 'docx';
import { RESUMEN } from '../diagramas/_figuras.mjs';
import { leerEsquema, marcas } from '../diagramas/_esquema.mjs';

const ESQUEMA = leerEsquema();
const TOTAL_FK = [...ESQUEMA.values()].reduce((a, t) => a + t.fks.length, 0);

// Rutas relativas al script: antes apuntaban a C:/dev/ferreplast y el
// documento solo se podia generar en la maquina donde se escribio.
const AQUI = dirname(fileURLToPath(import.meta.url));
const DIAG = join(AQUI, '..', 'diagramas');

// ---- Cifras del proyecto -----------------------------------------------------
// Las de pruebas salen de correr `npm test`; las del modelo, de las figuras.
const CIFRAS = {
  entidades: RESUMEN.entidades,          // 17
  relaciones: RESUMEN.relaciones,        // 30
  pruebasEsquema: 52,
  pruebasApi: 298,
  endpoints: 44,
};
CIFRAS.pruebas = CIFRAS.pruebasEsquema + CIFRAS.pruebasApi;

// ---- Paleta, la misma de los documentos web ---------------------------------
const TINTA   = '12181F';
const T_MED   = '3D4954';
const T_BAJA  = '66727E';
const AZUL    = '1F5673';
const AZUL_T  = 'E2EDF3';
const AMBAR   = 'A8551F';
const AMBAR_T = 'F6E8DC';
const CIRUELA = '6D4B7C';
const CIRU_T  = 'EFE7F3';
const LINEA   = 'C9D2DA';
const HUND    = 'E7EBEF';

// Tipografias presentes en cualquier Windows, para que el documento se vea
// igual en la maquina del profesor. IBM Plex y Spectral no estarian instaladas.
const F_TEXTO = 'Georgia';
const F_TIT   = 'Segoe UI Semibold';
const F_SANS  = 'Segoe UI';
const F_MONO  = 'Consolas';

const ANCHO_V = 9360;   // ancho util en pagina vertical  (8.5" - 2x1")
const PX_H    = 960;    // ancho util en pagina apaisada, en px a 96 ppp (10")

// ---- Rasterizado ------------------------------------------------------------
function png(archivo, anchoPx = 2600) {
  const svg = readFileSync(`${DIAG}/${archivo}`, 'utf8');
  const r = new Resvg(svg, {
    fitTo: { mode: 'width', value: anchoPx },
    font: { loadSystemFonts: true },
  });
  return r.render().asPng();
}

// ---- Ayudantes de composicion ----------------------------------------------
const t = (texto, o = {}) => new TextRun({
  text: texto, font: o.font ?? F_TEXTO, size: o.size ?? 21,
  color: o.color ?? TINTA, bold: o.bold, italics: o.italics, ...o.extra,
});

const p = (texto, o = {}) => new Paragraph({
  children: Array.isArray(texto) ? texto : [t(texto, o)],
  spacing: { after: o.after ?? 160, line: o.line ?? 300 },
  alignment: o.alignment,
  indent: o.indent,
  border: o.border,
  shading: o.shading,
});

const h1 = (n, texto) => new Paragraph({
  heading: HeadingLevel.HEADING_1,
  spacing: { before: 420, after: 60 },
  children: [
    new TextRun({ text: `${n}. `, font: F_TIT, size: 32, color: AZUL, bold: true }),
    new TextRun({ text: texto, font: F_TIT, size: 32, color: TINTA, bold: true }),
  ],
});

const h2 = (texto) => new Paragraph({
  heading: HeadingLevel.HEADING_2,
  spacing: { before: 300, after: 60 },
  children: [new TextRun({ text: texto, font: F_TIT, size: 24, color: TINTA, bold: true })],
});

const h3 = (texto) => new Paragraph({
  spacing: { before: 220, after: 60 },
  children: [new TextRun({ text: texto, font: F_SANS, size: 19, color: T_BAJA, bold: true,
                           allCaps: true, characterSpacing: 20 })],
});

const vineta = (texto, inst = 0) => new Paragraph({
  children: Array.isArray(texto) ? texto : [t(texto)],
  numbering: { reference: 'vinetas', level: 0, instance: inst },
  spacing: { after: 90, line: 290 },
});

const numerada = (texto, inst) => new Paragraph({
  children: Array.isArray(texto) ? texto : [t(texto)],
  numbering: { reference: 'numerada', level: 0, instance: inst },
  spacing: { after: 90, line: 290 },
});

// Recuadro para lo que falta confirmar en el levantamiento.
const recuadro = (rotulo, hijos, color, fondo) => new Table({
  columnWidths: [ANCHO_V],
  borders: {
    top:    { style: BorderStyle.SINGLE, size: 4, color: LINEA },
    bottom: { style: BorderStyle.SINGLE, size: 4, color: LINEA },
    left:   { style: BorderStyle.SINGLE, size: 18, color },
    right:  { style: BorderStyle.SINGLE, size: 4, color: LINEA },
    insideHorizontal: { style: BorderStyle.NONE },
    insideVertical:   { style: BorderStyle.NONE },
  },
  rows: [new TableRow({
    children: [new TableCell({
      width: { size: ANCHO_V, type: WidthType.DXA },
      shading: { type: ShadingType.CLEAR, fill: fondo },
      margins: { top: 160, bottom: 160, left: 220, right: 220 },
      children: [
        new Paragraph({
          spacing: { after: 100 },
          children: [new TextRun({ text: rotulo, font: F_SANS, size: 17, color,
                                   bold: true, allCaps: true, characterSpacing: 24 })],
        }),
        ...hijos,
      ],
    })],
  })],
});

const pendiente = (rotulo, hijos) => recuadro(rotulo, hijos, CIRUELA, CIRU_T);
const nota      = (rotulo, hijos) => recuadro(rotulo, hijos, AMBAR,   AMBAR_T);

// Celda de tabla.
function celda(contenido, ancho, o = {}) {
  const hijos = Array.isArray(contenido) && contenido[0] instanceof Paragraph
    ? contenido
    : [new Paragraph({
        spacing: { after: 0, line: 260 },
        children: Array.isArray(contenido) ? contenido : [
          new TextRun({
            text: String(contenido),
            font: o.font ?? F_TEXTO,
            size: o.size ?? 17,
            color: o.color ?? TINTA,
            bold: o.bold,
          }),
        ],
      })];
  return new TableCell({
    width: { size: ancho, type: WidthType.DXA },
    shading: o.fill ? { type: ShadingType.CLEAR, fill: o.fill } : undefined,
    margins: { top: 90, bottom: 90, left: 130, right: 130 },
    children: hijos,
  });
}

function tabla(anchos, cabeceras, filas) {
  return new Table({
    columnWidths: anchos,
    width: { size: anchos.reduce((a, b) => a + b, 0), type: WidthType.DXA },
    borders: {
      top:    { style: BorderStyle.SINGLE, size: 4, color: LINEA },
      bottom: { style: BorderStyle.SINGLE, size: 4, color: LINEA },
      left:   { style: BorderStyle.SINGLE, size: 4, color: LINEA },
      right:  { style: BorderStyle.SINGLE, size: 4, color: LINEA },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 2, color: LINEA },
      insideVertical:   { style: BorderStyle.SINGLE, size: 2, color: LINEA },
    },
    rows: [
      new TableRow({
        tableHeader: true,
        children: cabeceras.map((c, i) =>
          celda(c, anchos[i], { fill: HUND, font: F_SANS, size: 16, bold: true, color: T_MED })),
      }),
      ...filas.map((fila) => new TableRow({
        children: fila.map((c, i) => celda(c, anchos[i])),
      })),
    ],
  });
}

const mono = (s, color = TINTA) => new TextRun({ text: s, font: F_MONO, size: 16, color });
const cod  = (s) => new TextRun({ text: s, font: F_MONO, size: 16, color: AZUL, bold: true });
const fuerte = (s) => new TextRun({ text: s, font: F_SANS, size: 17, color: TINTA, bold: true });

// Figura en pagina apaisada.
//
// El salto de pagina se marca sobre el propio parrafo de la imagen y no como
// un parrafo aparte que contenga un PageBreak: ese parrafo suelto ocupa una
// linea en la pagina nueva, con lo que la imagen deja de entrar y se va a la
// siguiente, dejando una pagina en blanco.
function figura(archivo, ancho, alto, epigrafe, anchoPx, saltoAntes = false) {
  return [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 140 },
      pageBreakBefore: saltoAntes,
      children: [new ImageRun({
        type: 'png', data: png(archivo, anchoPx),
        transformation: { width: ancho, height: alto },
      })],
    }),
    new Paragraph({
      spacing: { after: 0, line: 280 },
      border: { left: { style: BorderStyle.SINGLE, size: 12, color: AZUL, space: 8 } },
      indent: { left: 120 },
      children: epigrafe,
    }),
  ];
}

const saltoPagina = () => new Paragraph({ children: [new PageBreak()] });

/** Alto en px de una figura a todo el ancho apaisado, leido de su viewBox. */
function alto(archivo) {
  const [, w, h] = readFileSync(join(DIAG, archivo), 'utf8').match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/);
  return Math.round(PX_H * h / w);
}

// =============================================================================
// CONTENIDO
// =============================================================================

// ---- Portada ----------------------------------------------------------------
// Es una funcion porque cuenta las reglas, que se definen mas abajo.
const portada = () => [
  new Paragraph({ spacing: { before: 1800, after: 0 },
    children: [new TextRun({ text: 'DOCUMENTO DE PRESENTACIÓN DE PROYECTO',
      font: F_SANS, size: 17, color: AZUL, bold: true, characterSpacing: 40 })] }),
  new Paragraph({ spacing: { before: 200, after: 0 },
    children: [new TextRun({ text: 'Ferreplast', font: F_TIT, size: 84, color: TINTA, bold: true })] }),
  new Paragraph({
    spacing: { before: 160, after: 400 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 8, color: LINEA, space: 10 } },
    children: [],
  }),
  p('Sistema de gestión, inventario y supervisión financiera para una ferretería y una plastiquería de la misma familia, que trabajan con conexión intermitente y llevan toda la administración a lápiz y papel.',
    { size: 23, color: T_MED, line: 340, after: 500 }),
  tabla([2600, 2600, 4160],
    ['Concepto', 'Valor', 'Observación'],
    [
      ['Tiendas', '2', 'Ferretería y plastiquería, en esquinas opuestas'],
      ['Entidades del modelo', String(CIFRAS.entidades), 'Más 2 subtipos de la especialización de USUARIO'],
      ['Relaciones', String(CIFRAS.relaciones), 'Una por clave foránea, más una jerarquía ISA'],
      ['Procesos definidos', String(PROCESOS.length), 'Ninguno estaba formalizado'],
      ['Reglas de negocio', String(REGLAS.length), `${REGLAS.filter((r) => r[3] === BD).length} impuestas por la base de datos`],
      ['Levantamiento', 'Realizado', 'Sus 3 cambios ya están en el modelo'],
      ['Estado', 'Base de datos y API construidas', `${CIFRAS.pruebas} pruebas automatizadas`],
    ]),
  saltoPagina(),
];

// ---- Índice -----------------------------------------------------------------
const indice = [
  h3('Contenido del documento'),
  ...[
    ['1', 'Introducción', 'qué contiene este documento'],
    ['2', 'Antecedentes', 'la situación de partida'],
    ['3', 'Justificación', 'por qué el proyecto debe aceptarse'],
    ['4', 'Objetivos', 'qué se busca lograr'],
    ['5', 'Alcance y limitaciones', 'qué entra y qué queda fuera'],
    ['6', 'Modelo conceptual', 'procesos y reglas de negocio'],
    ['7', 'Modelo entidad-relación', 'el modelo de datos y su trazabilidad'],
    ['8', 'Estado y plan de trabajo', 'qué está hecho y qué falta'],
    ['A', 'Anexo: diccionario de datos', 'cada tabla, columna por columna'],
  ].map(([n, titulo, desc]) => new Paragraph({
    spacing: { after: 80, line: 280 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 2, color: LINEA, space: 4 } },
    children: [
      new TextRun({ text: `${n}   `, font: F_MONO, size: 18, color: AZUL, bold: true }),
      new TextRun({ text: titulo, font: F_SANS, size: 20, color: TINTA, bold: true }),
      new TextRun({ text: `   ${desc}`, font: F_TEXTO, size: 18, color: T_BAJA, italics: true }),
    ],
  })),
  saltoPagina(),
];

// ---- 1. Introducción --------------------------------------------------------
const s1 = [
  h1(1, 'Introducción'),
  p('Este documento presenta el proyecto Ferreplast: un sistema de gestión para dos tiendas de una misma familia. Recorre de dónde parte el negocio, por qué el sistema está justificado, qué procesos hay que definir para que exista y cómo esos procesos se convierten en un modelo de datos concreto.',
    { size: 22, color: T_MED, line: 320 }),

  h3('Qué va a encontrar en cada sección'),
  vineta([fuerte('Antecedentes'), t(' — cómo nació el negocio y cómo se trabaja hoy: dos tiendas, dos cuadernos y ningún dato en común.')], 1),
  vineta([fuerte('Justificación'), t(' — los cinco problemas concretos que genera esa forma de trabajar, y por qué este sistema los resuelve en lugar de sólo digitalizarlos.')], 1),
  vineta([fuerte('Objetivos y alcance'), t(' — qué se propone lograr y, sobre todo, qué queda deliberadamente fuera de esta etapa.')], 1),
  vineta([fuerte('Modelo conceptual'), t(' — el núcleo del documento. El negocio no tiene procesos definidos, así que primero se identifican los que faltan, después se definen formalmente, y de cada uno se derivan las reglas de negocio.')], 1),
  vineta([fuerte('Modelo entidad-relación'), t(' — el modelo de datos, con una tabla de trazabilidad que demuestra que cada regla del modelo conceptual tiene correspondencia en el modelo de datos.')], 1),
  vineta([fuerte('Estado y plan de trabajo'), t(' — qué está construido y verificado, y qué falta.')], 1),

  h3('Cómo leer las marcas del documento'),
  p('Tres distintivos aparecen a lo largo del texto:'),
  vineta([
    new TextRun({ text: 'PENDIENTE', font: F_SANS, size: 17, color: CIRUELA, bold: true }),
    t(' — dato que debe confirmarse en el levantamiento de requerimientos con los dueños. No es información verificada y no debe presentarse como tal.'),
  ], 2),
  vineta([
    new TextRun({ text: 'BD', font: F_SANS, size: 17, color: AZUL, bold: true }),
    t(' — regla que la base de datos impone por sí misma, mediante restricciones o disparadores.'),
  ], 2),
  vineta([
    new TextRun({ text: 'APP', font: F_SANS, size: 17, color: AMBAR, bold: true }),
    t(' — regla que se valida en el programa, no en la base de datos.'),
  ], 2),

  pendiente('Sobre el estado del documento', [
    p('El levantamiento de requerimientos ya se realizó y sus resultados están en la sección 2. Confirmó buena parte del diseño, cerró una duda abierta y reveló tres cosas que el modelo no resolvía: empleados que trabajan en las dos tiendas, crédito a clientes y rebajas por mayoreo. Las tres ya están incorporadas al modelo y verificadas; el apartado 7.4 explica cómo quedó cada una.',
      { size: 20, after: 120, line: 290 }),
    p('Lo que sigue marcado como pendiente es lo que la visita dejó sin responder. Se mantiene a la vista a propósito, para que ningún dato supuesto se exponga como si fuera un hecho comprobado.',
      { size: 20, after: 0, line: 290 }),
  ]),
];

// ---- 2. Antecedentes --------------------------------------------------------
const s2 = [
  h1(2, 'Antecedentes'),
  p('La situación de partida: qué es el negocio, cómo funciona y qué lo trajo hasta acá.',
    { size: 22, color: T_MED, line: 320 }),

  h2('El negocio'),
  p('Una familia del pueblo administra dos tiendas. Una es una ferretería; la otra es una plastiquería, donde se vende de todo en plástico, desde cucharas descartables hasta barriles de doscientos litros. Ambas están sobre la misma calle, en esquinas opuestas.'),
  p('Los rubros son distintos pero el modo de operar es el mismo, y el dueño es el mismo. Esa combinación —dos puntos de venta independientes bajo una sola administración— es la que define el problema: cada tienda funciona bien por separado, pero no existe ningún lugar donde las dos se vean juntas.'),

  h2('Cómo se trabaja hoy'),
  p('Toda la gestión es manual, en papel. Las ventas se anotan en un cuaderno, el inventario se lleva en una libreta y el efectivo se cuenta al cerrar. No hay códigos de producto: los artículos se nombran como cada quien los conoce. Los precios están en la memoria de quien atiende.'),
  p('Funciona porque la gente que trabaja ahí es cuidadosa y conoce su mercadería. Pero cada tienda es una isla: para saber si un artículo hay en la otra esquina, alguien tiene que cruzar la calle o llamar por teléfono. Y para saber cuánto se ganó en el mes hay que sentarse a sumar comprobantes a mano.'),

  h3('Condiciones técnicas del entorno'),
  vineta([fuerte('Conexión a internet intermitente.'), t(' Hay señal, pero se corta. Un sistema que exija estar conectado para vender dejaría la tienda parada en cada corte.')], 3),
  vineta([fuerte('No hay equipos todavía.'), t(' Ninguna de las dos tiendas tiene computadora ni tablet. Todo el hardware es inversión nueva, así que el sistema debe correr en dispositivos económicos.')], 3),
  vineta([fuerte('Dos poblaciones de usuarios distintas.'), t(' Los empleados atienden el mostrador; la familia supervisa. Necesitan accesos y vistas diferentes.')], 3),

  h2('Resultados del levantamiento'),
  p('Se visitó a los dueños con una guía de preguntas. Lo que sigue es lo que respondieron y lo que cada respuesta implica para el sistema. Cinco respuestas confirman decisiones de diseño ya tomadas; tres obligaron a modificar el modelo, y esas modificaciones ya están hechas.'),
  tabla([1750, 3700, 3910],
    ['Tema', 'Lo que respondieron', 'Qué implica'],
    [
      [[fuerte('Cantidad de productos')], 'No la conocen. Nunca se contó cuántos artículos distintos manejan entre las dos tiendas.',
       'La carga inicial del catálogo pasa a ser el mayor riesgo del proyecto: no se puede planificar sin saber el tamaño.'],
      [[fuerte('Códigos de producto')], 'Ninguno tiene código. Todo se maneja en papel y los artículos se nombran como se los conoce.',
       'Hay que crear la codificación desde cero. Confirma el proceso PR-03 como trabajo previo obligatorio.'],
      [[fuerte('Unidades de venta')], 'Sí venden por medida: tubos, cuerdas y otros artículos por metro.',
       'Confirma la unidad de medida del producto, ya presente en el modelo.'],
      [[fuerte('Productos comunes')], 'Sí hay artículos que se venden igual en la ferretería y en la plastiquería.',
       'Confirma el catálogo único del negocio con existencias separadas por tienda.'],
      [[fuerte('Precios')], 'Iguales en las dos tiendas, pero varían según cómo esté el precio en el mercado.',
       'Valida congelar precio y costo en cada venta (RN-10): si cambian seguido, sin eso los reportes del pasado se recalcularían solos.'],
      [[fuerte('Descuentos')], 'Sí acostumbran hacer rebajas por mayoreo.',
       'Incorporado: la rebaja se registra en cada línea de la venta, sobre el producto que se rebajó, y nunca puede superar el importe del renglón.'],
      [[fuerte('Crédito a clientes')], 'Sí, los negocios dan fiado.',
       'Incorporado: clientes con límite de crédito, abonos a la cuenta y saldo calculado. Fue el cambio más grande.'],
      [[fuerte('Formas de pago')], 'Sólo efectivo.',
       'Simplifica el modelo. El fiado no es otra forma de pago: es una venta que se cobra después, también en efectivo.'],
      [[fuerte('Cierre de caja')], 'Cuentan el dinero a mano y lo verifican contra el cuaderno.',
       'Confirma el proceso PR-05 tal como se definió, incluido el contraste entre lo esperado y lo contado.'],
      [[fuerte('Empleados')], 'No saben cuántos son. Cada tienda tiene los suyos, pero algunos trabajan en las dos.',
       'Incorporado: un empleado puede estar asignado a una o a las dos tiendas, y elige desde cuál opera al entrar.'],
    ]),

  h3('Lo que pidió el dueño'),
  vineta([fuerte('Los dos negocios separados, en un solo sistema.'), t(' Quiere manejar la ferretería y la plastiquería por separado pero desde la misma plataforma. El modelo ya lo permite: son dos tiendas de un mismo negocio, con existencias independientes.')], 30),
  vineta([fuerte('Sin límite de productos.'), t(' Una base de datos relacional no impone ese límite; el catálogo puede crecer sin tocar el modelo.')], 30),
  vineta([fuerte('Que funcione también en computadora.'), t(' La aplicación web instalable cubre computadora, tablet y teléfono con el mismo código.')], 30),

  pendiente('Lo que quedó sin responder', [
    p('La ficha de datos de la visita no se completó. Falta para poder poner el sistema en marcha:',
      { size: 20, after: 120, line: 290 }),
    ...[
      'Nombre, dirección y horario de cada tienda.',
      'Cuántos empleados hay exactamente, y cuáles trabajan en las dos tiendas.',
      'Cómo llevan hoy la cuenta de quién debe, que es justamente lo que hay que reemplazar.',
      'Datos de contacto del responsable.',
      'Con qué frecuencia hacen conteo físico y qué diferencias suelen aparecer.',
    ].map((q) => vineta([t(q, { size: 20 })], 4)),
  ]),
];

// ---- 3. Justificación -------------------------------------------------------
const s3 = [
  h1(3, 'Justificación'),
  p('Por qué este proyecto debe aceptarse: qué problemas concretos existen, por qué el papel no puede resolverlos, y por qué la solución propuesta responde a esas necesidades y no a otras.',
    { size: 22, color: T_MED, line: 320 }),

  h2('Los problemas que genera trabajar en papel'),
  p('No son molestias: son pérdidas medibles. Cada uno se traduce en dinero o en decisiones tomadas a ciegas.'),
  tabla([700, 2200, 3230, 3230],
    ['N.º', 'Problema', 'Qué provoca', 'Cómo lo resuelve el sistema'],
    [
      [[cod('P1')], [fuerte('Las tiendas no comparten información')],
       'Para saber si hay un artículo en la otra tienda hay que cruzar la calle o llamar. El dato siempre llega tarde.',
       'Catálogo único con stock por tienda, consultable desde cualquiera de las dos y desde el panel del dueño.'],
      [[cod('P2')], [fuerte('El inventario se descuadra sin explicación')],
       'En el conteo aparecen diferencias, pero no se sabe si fueron error de anotación, rotura o faltante.',
       'Cada cambio de stock queda registrado con tipo, cantidad, responsable y momento. El historial es inalterable.'],
      [[cod('P3')], [fuerte('No se sabe cuánto se gana')],
       'Se conoce lo que se vendió, no lo que se ganó. Sin el costo de lo vendido, la utilidad es una impresión.',
       'Cada línea de venta guarda el precio y el costo del momento. La ganancia se calcula sola, por tienda y por período.'],
      [[cod('P4')], [fuerte('Todo depende de las personas')],
       'Los precios y el stock viven en la memoria de quien atiende. Si falta, la tienda opera a ciegas.',
       'Precios y existencias en el sistema. Cualquiera puede atender siguiendo la pantalla.'],
      [[cod('P5')], [fuerte('No se puede anticipar el desabastecimiento')],
       'Se descubre que faltó un artículo cuando el cliente ya se fue. La compra de urgencia sale más cara.',
       'Umbral mínimo por producto y por tienda, con aviso de reposición antes de que se agote.'],
    ]),

  h2('Por qué un sistema, y por qué este'),
  p('Los cinco problemas comparten una causa: el papel registra hechos sueltos pero no los relaciona. Un cuaderno puede decir que se vendieron cincuenta tornillos; no puede decir cuánto costaron, cuántos quedan, quién los vendió ni cómo se compara eso con la otra tienda. Digitalizar el cuaderno —pasarlo a una planilla— no arregla nada: sigue siendo información suelta, ahora en pantalla.'),
  p('Lo que hace falta es un modelo de datos relacionado, donde cada venta esté unida a sus productos, a su tienda, a su vendedor y a su caja. Ahí es donde una base de datos deja de ser un archivo y pasa a responder preguntas que hoy nadie puede contestar.'),

  h2('Por qué la arquitectura tiene que ser así'),
  p('La conexión intermitente no es un detalle de implementación: condiciona el modelo de datos entero. Un sistema convencional guarda el stock como un número que sube y baja. Con dos tiendas trabajando desconectadas, ese número se pisa: la última en sincronizar borra lo que hizo la otra, y la mercadería desaparece de los registros.'),
  p('Por eso el inventario no se guarda como un total, sino como el registro de los hechos que lo modificaron. Sumar movimientos independientes da el mismo resultado sin importar en qué orden lleguen. Esa decisión es la que hace viable trabajar sin conexión, y explica buena parte de la forma del modelo entidad-relación.'),

  h2('Viabilidad'),
  vineta([fuerte('Técnica.'), t(` La base de datos en SQL Server y la API que la expone (${CIFRAS.endpoints} rutas: ventas, inventario, caja, crédito, usuarios, sincronización y reportes) ya están construidas y verificadas con ${CIFRAS.pruebas} pruebas automatizadas, y el punto de venta para la tablet ya vende con y sin señal. No es una propuesta teórica.`)], 5),
  vineta([fuerte('Económica.'), t(' El hardware necesario son dos tablets de gama básica. SQL Server Express es gratuito y su capacidad sobra para dos tiendas.')], 5),
  vineta([fuerte('Operativa.'), t(' La pantalla de venta tiene tres pasos: buscar, agregar, cobrar. No exige capacitación técnica ni cambiar la forma de atender.')], 5),

  h2('El sistema tiene competencia'),
  p('En el levantamiento, la dueña mencionó que está considerando comprar un gestor de inventario ya existente, Akasia, con licencia permanente de alrededor de doscientos dólares. Conviene decirlo con claridad en lugar de omitirlo, porque cambia los términos de la discusión.'),
  p('Un producto establecido tiene ventajas reales que este proyecto no puede igualar en el corto plazo: está probado por muchos negocios, tiene soporte, y no arrastra los errores que todo desarrollo nuevo va encontrando por el camino. A ese precio, la comparación no se gana por costo.'),
  p('Lo que sí distingue a este sistema es que se construye sobre los procesos reales de estas dos tiendas, que el levantamiento ya documentó: el fiado tal como lo llevan, dos locales con catálogo compartido y existencias separadas, y operación sin conexión para la señal intermitente que tienen. Un producto genérico puede resolver esos casos o no; es lo primero que habría que verificar antes de comprarlo.'),
  nota('Conclusión honesta sobre la venta', [
    p('La decisión de compra es del cliente y hay una alternativa más barata sobre la mesa. Este documento no pretende argumentar lo contrario. Lo que sí queda establecido es que los dueños autorizaron usar el negocio como caso de estudio, de modo que el proyecto académico se sostiene con independencia de si el sistema termina vendiéndose.',
      { size: 20, after: 0, line: 290 }),
  ]),
];

// ---- 4. Objetivos -----------------------------------------------------------
const s4 = [
  h1(4, 'Objetivos'),
  p([new TextRun({ text: 'Sección añadida. ', font: F_SANS, size: 20, color: CIRUELA, bold: true }),
     t('No figuraba en las indicaciones recibidas, pero casi toda rúbrica de proyecto la exige y se desprende sola de la justificación. Si no hace falta, se quita sin afectar al resto.',
       { size: 21, color: T_MED })], { line: 320 }),

  h2('Objetivo general'),
  p('Desarrollar un sistema de gestión de inventario, ventas y supervisión financiera para las dos tiendas de la familia, capaz de operar sin conexión permanente a internet y de consolidar la información de ambas en un único panel de administración.'),

  h2('Objetivos específicos'),
  ...[
    'Definir formalmente los procesos de negocio que hoy se ejecutan de manera informal, y derivar de ellos las reglas que el sistema debe hacer cumplir.',
    'Diseñar un modelo de datos relacional que soporte esas reglas y permita auditar todo cambio de inventario.',
    'Implementar un mecanismo de sincronización que permita a cada tienda operar desconectada sin perder ni duplicar operaciones al reconectarse.',
    'Construir un punto de venta que un empleado pueda usar sin conocimientos técnicos.',
    'Proveer al dueño un panel con ventas, inventario valorizado, ganancia real y avisos de reposición de ambas tiendas.',
    'Verificar el sistema con pruebas automatizadas que comprueben las reglas de negocio, no sólo el funcionamiento del código.',
  ].map((o) => numerada(o, 10)),
];

// ---- 5. Alcance -------------------------------------------------------------
const s5 = [
  h1(5, 'Alcance y limitaciones'),
  p([new TextRun({ text: 'Sección añadida. ', font: F_SANS, size: 20, color: CIRUELA, bold: true }),
     t('Decir con precisión qué no hace el sistema evita la discusión más incómoda: la que ocurre en la entrega, cuando el cliente esperaba algo que nunca estuvo acordado.',
       { size: 21, color: T_MED })], { line: 320 }),

  tabla([4680, 4680],
    ['Entra en esta etapa', 'Queda fuera'],
    [
      ['Catálogo de productos con categorías y precios', 'Facturación fiscal y comprobantes con validez tributaria'],
      ['Inventario por tienda con historial auditable', 'Gestión de proveedores y órdenes de compra'],
      ['Punto de venta con funcionamiento sin conexión', 'Facturación electrónica'],
      ['Cierre de caja con detección de descuadre', 'Nómina, sueldos y comisiones de empleados'],
      ['Crédito a clientes con límite y abonos', 'Intereses o recargos sobre la deuda'],
      ['Panel consolidado de las dos tiendas', 'Contabilidad general y balances'],
      ['Avisos de stock bajo', 'Venta por internet o catálogo público'],
      ['Roles diferenciados de empleado y administrador', 'Lector de código de barras (previsto, no incluido)'],
    ]),

  h3('Limitaciones conocidas'),
  vineta([fuerte('Fiar exige conexión.'), t(' Es una decisión, no un faltante. El límite de crédito se controla contra el saldo del cliente, que es uno solo para las dos tiendas. Dos tablets sin señal no ven lo que fió la otra, y entre las dos podrían fiarle a la misma persona el doble de su límite. Sin internet se vende en efectivo; el fiado espera a que vuelva la señal.')], 6),
  vineta([fuerte('La rebaja por mayoreo no tiene tabla de precios.'), t(' Los dueños no manejan precios de mayoreo fijos: la rebaja la negocia quien atiende. El sistema la registra en cada línea y no deja que supere el importe del renglón, pero no la calcula sola.')], 6),
  vineta([fuerte('Traspasos entre tiendas sin vínculo.'), t(' Mover mercadería de una esquina a la otra se registra hoy como dos movimientos sueltos, sin relación entre ellos.')], 6),
  vineta([fuerte('Sin conexión no hay panel.'), t(' El punto de venta funciona desconectado; la supervisión consolidada requiere internet, por definición.')], 6),
  vineta([fuerte('La sincronización tiene demora.'), t(' Si una tablet pasa horas sin señal, el panel muestra datos con esa antigüedad. El sistema informa cuánto hace que cada dispositivo no sincroniza.')], 6),
];

// ---- 6. Modelo conceptual ---------------------------------------------------
const ficha = (codigo, titulo, disparador, pasos, reglas, inst) => [
  new Paragraph({
    spacing: { before: 300, after: 40 },
    children: [
      new TextRun({ text: `${codigo}   `, font: F_MONO, size: 17, color: AZUL, bold: true }),
      new TextRun({ text: titulo, font: F_TIT, size: 22, color: TINTA, bold: true }),
    ],
  }),
  p(disparador, { size: 19, color: T_BAJA, italics: true, after: 120 }),
  ...pasos.map((paso) => numerada(paso, inst)),
  new Paragraph({
    spacing: { before: 100, after: 60 },
    children: [new TextRun({ text: 'Reglas que genera', font: F_SANS, size: 16, color: T_BAJA,
                             bold: true, allCaps: true, characterSpacing: 20 })],
  }),
  ...reglas.map(([rn, texto]) => vineta([
    new TextRun({ text: `${rn}  `, font: F_MONO, size: 17, color: AZUL, bold: true }),
    t(texto, { size: 20 }),
  ], inst + 100)),
];

const noExiste = (texto, rotulo = 'NO EXISTE. ', color = AMBAR) =>
  [new TextRun({ text: rotulo, font: F_SANS, size: 16, color, bold: true }), t(texto, { size: 17 })];

// [codigo, proceso, como esta hoy, que falta]
const PROCESOS = [
  ['PR-01', 'Registro de venta', 'Se anota en un cuaderno, sin formato fijo', 'Formato único, cálculo del total, descuento del stock'],
  ['PR-02', 'Recepción de mercadería', 'Se guarda y se recuerda; no siempre se anota', 'Registro de entrada con costo, para valorizar el inventario'],
  ['PR-03', 'Alta y codificación de producto', 'Cada artículo se nombra como se lo conoce', 'Código único, unidad de medida, categoría y precio'],
  ['PR-04', 'Fijación y cambio de precio', 'El precio vive en la memoria del dueño', 'Precio registrado, y precio histórico de cada venta'],
  ['PR-05', 'Cierre de caja', 'Se cuenta el efectivo, sin compararlo contra lo esperado', 'Monto esperado calculado y descuadre detectado'],
  ['PR-06', 'Conteo físico y ajuste', 'Esporádico; las diferencias se asumen sin explicación', 'Ajuste registrado como movimiento, con motivo'],
  ['PR-07', 'Registro de merma', noExiste('Lo roto o vencido se descarta sin registro'), 'Distinguir la pérdida de la venta: una es costo, la otra ingreso'],
  ['PR-08', 'Reposición de inventario', 'Se compra cuando se nota que falta', 'Umbral mínimo por producto y aviso anticipado'],
  ['PR-09', 'Control de acceso del personal', noExiste('Cualquiera anota en el cuaderno'), 'Identificación del responsable de cada operación, en la tienda desde la que opera'],
  ['PR-10', 'Supervisión consolidada', 'Visitando ambas tiendas o llamando por teléfono', 'Vista única de las dos tiendas con ganancia real'],
  ['PR-11', 'Sincronización entre tiendas', noExiste('No hay nada que sincronizar en papel', 'NO APLICA. ', T_BAJA), 'Proceso nuevo que introduce el sistema'],
  ['PR-12', 'Crédito y cobranza', 'Se anota en el cuaderno quién debe; sin límite y sin saldo a la vista', 'Cliente identificado, límite de crédito y saldo que se calcula solo'],
];

const s6 = [
  h1(6, 'Modelo conceptual'),
  p('El punto de partida real de este proyecto: el negocio no tiene procesos definidos. Nadie escribió nunca cómo se registra una venta o qué se hace cuando llega mercadería. Antes de modelar datos hay que definir esos procesos, porque son ellos los que dictan las reglas, y las reglas las que dictan el modelo.',
    { size: 22, color: T_MED, line: 320 }),

  h2('6.1  Qué significa que no haya procesos definidos'),
  p('Las tiendas funcionan, así que algo se hace. Pero lo que se hace es práctica heredada, no procedimiento: cada persona lo ejecuta a su manera, no está escrito, y no produce un registro consultable. Un proceso definido tiene disparador, pasos, un responsable y un rastro que queda. Nada de eso existe hoy.'),
  p('La consecuencia práctica es que no se puede automatizar lo que no está definido. Si dos empleados anotan la venta de manera distinta, no hay forma de programar el registro de una venta. Por eso el primer trabajo del proyecto no fue técnico: fue proponer los procesos que faltaban.'),

  h2('6.2  Inventario de procesos'),
  p(`Se identificaron ${PROCESOS.length} procesos necesarios para operar las dos tiendas. Ninguno estaba formalizado; diez existen como práctica informal y dos directamente no existen. El de crédito (PR-12) se agregó tras el levantamiento, cuando los dueños confirmaron que fían.`),
  tabla([900, 2100, 3180, 3180],
    ['N.º', 'Proceso', 'Cómo está hoy', 'Qué falta'],
    PROCESOS.map(([n, nombre, hoy, falta]) => [[cod(n)], [fuerte(nombre)], hoy, falta])),

  h2('6.3  Procesos definidos'),
  p('Definición formal de los seis procesos centrales. Cada ficha indica qué lo dispara, los pasos que lo componen y las reglas de negocio que genera. Los seis restantes siguen la misma estructura y se resumen en la tabla de reglas del apartado 6.4.'),

  ...ficha('PR-01', 'Registro de venta',
    'Se dispara cuando un cliente decide llevar mercadería.',
    ['El empleado se identifica con su PIN; si trabaja en las dos tiendas, elige desde cuál opera.',
     'Busca cada producto por nombre o código y ve el precio y las existencias.',
     'Arma el pedido indicando la cantidad de cada artículo y, si corresponde, la rebaja por mayoreo de cada uno.',
     'Cobra en efectivo o, si es fiado, elige al cliente (ver PR-12).',
     'El sistema registra la venta, su detalle y la salida de stock, todo junto.'],
    [['RN-08', 'Una venta necesita al menos una línea de detalle.'],
     ['RN-09', 'El total es el subtotal menos el descuento, sin excepción.'],
     ['RN-10', 'El precio y el costo se copian al vender y ya no cambian.'],
     ['RN-11', 'El número de comprobante es único dentro de la tienda.'],
     ['RN-36', 'La rebaja por mayoreo va en la línea y no puede superar su importe.'],
     ['RN-06', 'Una venta descuenta stock: nunca lo aumenta.'],
     ['RN-23', 'La venta, su detalle y el descuento de stock se guardan juntos o no se guarda nada.']], 20),

  ...ficha('PR-02', 'Recepción de mercadería',
    'Se dispara cuando llega una compra del proveedor.',
    ['El encargado verifica lo recibido contra lo pedido.',
     'Registra una entrada por cada producto, con su cantidad.',
     'Indica el costo unitario pagado en esta compra.',
     'Anota el motivo, que identifica al proveedor o la remisión.',
     'El stock de esa tienda sube automáticamente.'],
    [['RN-05', 'Toda entrada o salida queda registrada con tipo, cantidad, responsable y momento.'],
     ['RN-06', 'Una entrada debe tener cantidad positiva.'],
     ['RN-24', 'El costo se guarda en el momento de la entrada, para valorizar el inventario histórico.'],
     ['RN-03', 'La entrada afecta el stock de una tienda concreta, no del negocio.']], 21),

  ...ficha('PR-05', 'Cierre de caja',
    'Se dispara al terminar el turno o la jornada.',
    ['Al abrir, se registra el monto inicial que queda en el cajón.',
     'Durante el turno, las ventas en efectivo y los abonos de clientes en efectivo se asocian a esa caja.',
     'Al cerrar, el sistema calcula cuánto efectivo debería haber.',
     'El empleado cuenta el dinero real y lo ingresa.',
     'El sistema registra la diferencia entre lo esperado y lo contado.'],
    [['RN-12', 'Una tienda no puede tener dos cajas abiertas al mismo tiempo.'],
     ['RN-13', 'El descuadre se calcula, nunca se escribe a mano.'],
     ['RN-14', 'Una caja no puede cerrarse sin declarar el efectivo contado.'],
     ['RN-25', 'Lo contado se guarda; lo esperado se recalcula, para poder auditar cuál estaba mal.'],
     ['RN-34', 'Un abono en efectivo entra al arqueo de la caja en la que se recibió.']], 22),

  ...ficha('PR-06', 'Conteo físico y ajuste',
    'Se dispara al hacer inventario, o ante una diferencia detectada.',
    ['Se cuenta físicamente la existencia de cada producto.',
     'Se compara contra lo que el sistema indica.',
     'Ante una diferencia, se registra un ajuste con la cantidad que corrige.',
     'Se anota el motivo del ajuste.',
     'El registro anterior no se modifica: el ajuste se suma al historial.'],
    [['RN-07', 'El historial de inventario no se puede alterar ni borrar.'],
     ['RN-26', 'Todo error se corrige agregando un ajuste, nunca reescribiendo el pasado.'],
     ['RN-04', 'El stock es el resultado de sumar los movimientos, no un número que se edita.'],
     ['RN-27', 'Un movimiento de cantidad cero no se admite: no significa nada.']], 23),

  ...ficha('PR-11', 'Sincronización entre tiendas',
    'Se dispara automáticamente cuando vuelve la señal de internet.',
    ['Mientras no hay conexión, la tablet acumula las operaciones en una cola local.',
     'Cada operación lleva un identificador propio generado en el dispositivo.',
     'Al reconectarse, la tablet envía la cola al servidor.',
     'El servidor descarta lo que ya tenía y acepta lo nuevo.',
     'Informa qué aceptó, qué era repetido y qué rechazó, con el motivo.'],
    [['RN-20', 'Reenviar una operación no la duplica: el identificador lo impide.'],
     ['RN-28', 'Un registro con error no bloquea al resto del envío.'],
     ['RN-04', 'Los movimientos se suman, así que el orden de llegada no altera el resultado.'],
     ['RN-29', 'Se registra cuándo sincronizó cada dispositivo por última vez.'],
     ['RN-35', 'Una venta a crédito no se acepta por la cola sin conexión.']], 24),

  ...ficha('PR-12', 'Crédito y cobranza',
    'Se dispara cuando un cliente se lleva mercadería sin pagar, o cuando vuelve a abonar.',
    ['El empleado busca al cliente o, si es nuevo, lo registra con su nombre y teléfono.',
     'El sistema muestra cuánto debe y cuánto le queda de límite.',
     'Con conexión, se registra la venta como crédito a nombre del cliente.',
     'Cuando el cliente abona, el monto se registra contra su cuenta, no contra una factura.',
     'Si el abono es en efectivo, queda asociado a la caja abierta del turno.'],
    [['RN-30', 'No se puede fiar sin indicar a quién.'],
     ['RN-31', 'La deuda de un cliente no puede superar su límite de crédito.'],
     ['RN-32', 'El saldo no se guarda: es lo fiado menos lo abonado.'],
     ['RN-33', 'Un abono es mayor que cero y no se paga con otra deuda.'],
     ['RN-35', 'Fiar exige conexión: el límite se controla contra el saldo de las dos tiendas.']], 25),

  h2('6.4  Reglas de negocio'),
  p('Las reglas derivadas de los procesos anteriores, con el lugar donde cada una se hace cumplir. Que una regla esté en la base de datos significa que se cumple aunque el programa tenga un error o alguien se conecte directamente a la base; que esté en la aplicación significa que depende del programa.'),
];

const BD  = () => [new TextRun({ text: 'BD', font: F_SANS, size: 16, color: AZUL, bold: true })];
const APP = () => [new TextRun({ text: 'APP', font: F_SANS, size: 16, color: AMBAR, bold: true })];

// El mecanismo es el nombre real del objeto en db/schema.sql, para que se
// pueda buscar. Si se renombra una restriccion, hay que cambiarlo aca.
const REGLAS = [
  ['RN-01', 'Un producto pertenece al negocio, no a una tienda', 'PR-03', BD, 'PRODUCTO sin tienda_id; existencias en Stock'],
  ['RN-02', 'El código de producto, si existe, es único', 'PR-03', BD, 'UX_PRODUCTO_CODIGO (índice filtrado)'],
  ['RN-03', 'El stock es por tienda: una sola fila por par', 'PR-02', BD, 'PK_STOCK (tienda_id, producto_id)'],
  ['RN-04', 'El stock se deduce sumando los movimientos', 'PR-06', BD, 'trg_movimiento_actualiza_stock'],
  ['RN-05', 'Todo cambio de stock queda registrado con responsable y momento', 'PR-02', BD, 'MOVIMIENTO_INVENTARIO'],
  ['RN-06', 'Una venta o merma resta; una entrada o devolución suma', 'PR-01', BD, 'CK_MOVIMIENTO_SIGNO'],
  ['RN-07', 'El historial de inventario es inalterable', 'PR-06', BD, 'trg_movimientos_inmutables'],
  ['RN-08', 'Una venta necesita al menos una línea', 'PR-01', APP, 'validación de la API'],
  ['RN-09', 'Total = subtotal menos descuento', 'PR-01', BD, 'CK_VENTA_TOTAL, CK_LINEA_SUBTOTAL'],
  ['RN-10', 'El precio y el costo se congelan al vender', 'PR-04', BD, 'VENTA_LINEA.precio_unitario, costo_unitario'],
  ['RN-11', 'El número de venta es único dentro de la tienda', 'PR-01', BD, 'UQ_VENTA_NUMERO (lo asigna el servidor)'],
  ['RN-12', 'Una tienda no puede tener dos cajas abiertas', 'PR-05', BD, 'UX_CAJA_ABIERTA_POR_TIENDA'],
  ['RN-13', 'El descuadre de caja se calcula, no se captura', 'PR-05', APP, 'lo calcula el servidor al cerrar'],
  ['RN-14', 'No se cierra caja sin declarar el efectivo contado', 'PR-05', BD, 'CK_CAJA_CIERRE_COMPLETO'],
  ['RN-15', 'El empleado opera solo sus tiendas; el administrador ve ambas', 'PR-09', APP, 'USUARIO_TIENDA, SESION.tienda_id'],
  ['RN-16', 'Las credenciales dependen del rol', 'PR-09', BD, 'CK_USUARIO_CREDENCIALES'],
  ['RN-17', 'No se borra un producto con historial', 'PR-03', BD, 'claves foráneas sin cascada'],
  ['RN-18', 'Borrar una venta borra su detalle', 'PR-01', BD, 'FK_VENTALINEA_VENTA ON DELETE CASCADE'],
  ['RN-19', 'El dato histórico sobrevive a la baja del empleado', 'PR-09', BD, 'baja lógica: Usuario.activo'],
  ['RN-20', 'Reenviar una operación no la duplica', 'PR-11', BD, 'UX_VENTA_UUID, UX_MOV_UUID'],
  ['RN-21', 'Las categorías forman jerarquía', 'PR-03', BD, 'FK_CATEGORIA_PADRE'],
  ['RN-22', 'Se avisa cuando el stock baja del mínimo', 'PR-08', BD, 'Stock.necesita_reposicion, v_alertas_stock'],
  ['RN-23', 'Venta, detalle y stock se guardan juntos o nada', 'PR-01', APP, 'transacción'],
  ['RN-24', 'El costo se guarda al recibir la mercadería', 'PR-02', BD, 'MOVIMIENTO_INVENTARIO.costo_unitario'],
  ['RN-25', 'Lo contado se guarda; lo esperado se recalcula', 'PR-05', BD, 'CAJA.efectivo_contado, v_cuadre_caja'],
  ['RN-26', 'Los errores se corrigen con un ajuste, no reescribiendo', 'PR-06', BD, "CK_MOVIMIENTO_TIPO ('ajuste')"],
  ['RN-27', 'Un movimiento de cantidad cero no se admite', 'PR-06', BD, 'CK_MOVIMIENTO_NO_CERO'],
  ['RN-28', 'Un registro con error no bloquea el resto del envío', 'PR-11', APP, 'proceso por elemento'],
  ['RN-29', 'Se registra la última sincronización de cada dispositivo', 'PR-11', BD, 'DISPOSITIVO.ultimo_sync, SYNC_LOG'],
  ['RN-30', 'No se fía sin indicar a quién', 'PR-12', BD, 'CK_VENTA_CLIENTE_CREDITO'],
  ['RN-31', 'La deuda no puede superar el límite de crédito', 'PR-12', BD, 'trg_venta_credito_limite'],
  ['RN-32', 'El saldo es lo fiado menos lo abonado', 'PR-12', BD, 'v_cuentas_por_cobrar'],
  ['RN-33', 'Un abono es positivo y no se paga con crédito', 'PR-12', BD, 'CK_PAGO_MONTO, CK_PAGO_METODO'],
  ['RN-34', 'El abono en efectivo entra al arqueo de su caja', 'PR-05', BD, 'PAGO_CREDITO.caja_id, v_cuadre_caja'],
  ['RN-35', 'Fiar exige conexión', 'PR-12', APP, 'la sincronización rechaza el crédito'],
  ['RN-36', 'La rebaja por mayoreo va en la línea y no supera su importe', 'PR-01', BD, 'CK_LINEA_DESCUENTO'],
  ['RN-37', 'Un empleado puede trabajar en varias tiendas con un solo usuario', 'PR-09', BD, 'PK_USUARIO_TIENDA'],
  ['RN-38', 'El ingreso se bloquea tras 5 intentos fallidos en 15 minutos', 'PR-09', APP, 'INTENTO_LOGIN'],
  ['RN-39', 'Una sesión se puede revocar en cualquier momento', 'PR-09', BD, 'SESION.revocada_en'],
  ['RN-40', 'Con conexión no se vende más de lo que hay en existencia', 'PR-01', APP, 'POST /ventas, con bloqueo de Stock'],
];
const reglasApp = REGLAS.filter((r) => r[3] === APP).map((r) => r[0]);

s6.push(
  tabla([800, 3400, 900, 900, 3360],
    ['N.º', 'Regla', 'Proceso', 'Dónde', 'Mecanismo'],
    REGLAS.map(([n, regla, proc, donde, mec]) => [
      [cod(n)], regla, [mono(proc, T_MED)], donde(), [mono(mec)],
    ])),
  nota(`Sobre las ${reglasApp.length} reglas que vive la aplicación`, [
    p(`${reglasApp.join(', ')} no las impone la base de datos. Conviene decirlo antes de que lo señalen, y cada una tiene su razón:`,
      { size: 20, after: 100, line: 290 }),
    ...[
      [fuerte('RN-08.'), t(' Si alguien se conectara directamente a la base podría insertar una venta sin líneas. SQL Server no tiene restricciones diferidas, que es lo que haría falta para exigirlo sin impedir la carga de la cabecera antes que sus líneas.', { size: 20 })],
      [fuerte('RN-13.'), t(' La diferencia de caja la calcula el servidor al cerrar. La base guarda lo contado y la vista v_cuadre_caja recalcula lo esperado, así que un valor mal guardado se detecta.', { size: 20 })],
      [fuerte('RN-15.'), t(' Desde que un empleado puede estar en las dos tiendas, la pertenencia vive en otra tabla, y una restricción CHECK no puede consultar otra tabla.', { size: 20 })],
      [fuerte('RN-23, RN-28 y RN-35.'), t(' Son reglas sobre cómo se procesa un envío, no sobre qué datos son válidos: viven donde está ese proceso.', { size: 20 })],
      [fuerte('RN-38.'), t(' Contar intentos fallidos y bloquear es comportamiento de la puerta de entrada; la base sólo guarda el registro.', { size: 20 })],
      [fuerte('RN-40.'), t(' Una restricción en la base rechazaría también la venta que llega sin conexión, que ya ocurrió: la mercadería salió y el cliente tiene su ticket. Se exige en la venta con conexión y se deja pasar en la sincronización, donde el stock negativo queda a la vista para revisar.', { size: 20 })],
    ].map((v) => vineta(v, 26)),
  ]),
);

// ---- 7. MER -----------------------------------------------------------------
const s7a = [
  h1(7, 'Modelo entidad-relación'),
  p('Todo lo que dice el modelo conceptual tiene que estar en el modelo de datos. Esta sección lo demuestra dos veces: primero mostrando cómo un proceso concreto se convierte en escrituras sobre entidades, y después con una tabla que recorre proceso por proceso.',
    { size: 22, color: T_MED, line: 320 }),
  h2('7.1  De un proceso a las entidades'),
  p('El proceso de venta, paso a paso, con lo que cada paso lee o escribe en el modelo. Es la forma más directa de ver que el modelo conceptual y el modelo entidad-relación son la misma cosa contada de dos maneras. La figura 1 está en la página siguiente.'),
];

// Proceso -> entidades que lo sostienen y reglas en las que interviene.
// Al final se comprueba que la tabla cubra TODAS las entidades del modelo y
// que cada regla aparezca al menos en el proceso que la origina: si no, el
// documento no se genera, en vez de afirmar una trazabilidad que no cumple.
const TRAZABILIDAD = [
  ['PR-01 Registro de venta', ['VENTA', 'VENTA_LINEA', 'MOVIMIENTO_INVENTARIO', 'STOCK', 'PRODUCTO', 'USUARIO', 'TIENDA', 'CAJA'], [6, 8, 9, 11, 18, 23, 36, 40]],
  ['PR-02 Recepción de mercadería', ['MOVIMIENTO_INVENTARIO', 'STOCK', 'PRODUCTO', 'TIENDA', 'USUARIO'], [3, 5, 6, 24]],
  ['PR-03 Alta de producto', ['PRODUCTO', 'CATEGORIA', 'NEGOCIO'], [1, 2, 17, 21]],
  ['PR-04 Fijación de precio', ['PRODUCTO', 'VENTA_LINEA'], [10]],
  ['PR-05 Cierre de caja', ['CAJA', 'VENTA', 'PAGO_CREDITO', 'USUARIO', 'TIENDA'], [12, 13, 14, 25, 34]],
  ['PR-06 Conteo y ajuste', ['MOVIMIENTO_INVENTARIO', 'STOCK'], [4, 7, 26, 27]],
  ['PR-07 Registro de merma', ['MOVIMIENTO_INVENTARIO', 'STOCK'], [5, 6]],
  ['PR-08 Reposición', ['STOCK', 'PRODUCTO', 'TIENDA'], [22]],
  ['PR-09 Control de acceso', ['USUARIO', 'USUARIO_TIENDA', 'SESION', 'INTENTO_LOGIN', 'TIENDA', 'NEGOCIO'], [15, 16, 19, 37, 38, 39]],
  ['PR-10 Supervisión consolidada', ['VENTA', 'VENTA_LINEA', 'STOCK', 'PRODUCTO', 'TIENDA', 'CAJA'], [10, 22, 25]],
  ['PR-11 Sincronización', ['DISPOSITIVO', 'SYNC_LOG', 'SESION', 'MOVIMIENTO_INVENTARIO', 'VENTA'], [4, 20, 28, 29, 35]],
  ['PR-12 Crédito y cobranza', ['CLIENTE', 'PAGO_CREDITO', 'VENTA', 'CAJA', 'NEGOCIO'], [30, 31, 32, 33, 35]],
];

{
  const usadas = new Set(TRAZABILIDAD.flatMap(([, ents]) => ents));
  const faltan = RESUMEN.nombres.filter((e) => !usadas.has(e));
  const sobran = [...usadas].filter((e) => !RESUMEN.nombres.includes(e));
  const reglaSinProceso = REGLAS.filter(([rn, , proc]) => !TRAZABILIDAD.some(([pr, , rs]) =>
    pr.startsWith(proc) && rs.includes(+rn.slice(3))));
  if (faltan.length || sobran.length || reglaSinProceso.length) {
    throw new Error(`Trazabilidad incompleta. Entidades sin proceso: ${faltan.join(', ') || '-'}. ` +
      `Nombres que no son entidades: ${sobran.join(', ') || '-'}. ` +
      `Reglas fuera de su proceso: ${reglaSinProceso.map((r) => r[0]).join(', ') || '-'}.`);
  }
}

const dosDig = (n) => String(n).padStart(2, '0');

const s7b = [
  h2('7.2  Trazabilidad del modelo conceptual al modelo de datos'),
  p('Proceso por proceso, las entidades que lo sostienen. Ninguna entidad del modelo existe porque sí: todas aparecen porque algún proceso las necesita.'),
  tabla([2400, 4560, 2400],
    ['Proceso', 'Entidades que intervienen', 'Reglas'],
    TRAZABILIDAD.map(([proc, ents, rs]) => [
      [fuerte(proc)], [mono(ents.join(', '), T_MED)],
      [mono(`RN-${rs.map(dosDig).join(', ')}`, T_MED)],
    ])),
  p(`La correspondencia se cumple en los dos sentidos. Las ${CIFRAS.entidades} entidades del modelo aparecen al menos una vez en la columna del medio: no hay ninguna que no responda a un proceso. Y los ${PROCESOS.length} procesos tienen entidades que los sostienen: ninguno quedó sin modelar.`),
  h2('7.3  El modelo entidad-relación'),
  p(`El modelo completo se presenta en cuatro figuras. La figura 2 muestra las ${CIFRAS.entidades} entidades y las ${CIFRAS.relaciones} relaciones juntas; por su densidad conviene para ver la forma general. Las figuras 3, 4 y 5 parten ese mismo modelo en vistas legibles: la estructura del negocio y el catálogo; la operación de venta, caja y crédito; y el acceso y la sincronización. Están en las páginas siguientes.`),
  p('Los recorridos de las líneas no se dibujaron a mano: los calcula el script que genera los diagramas, que además verifica que ninguna línea atraviese una entidad y ningún rótulo quede encima de una línea.'),
];

const s7c = [
  h2('7.4  Cambios que exigió el levantamiento'),
  p('La primera versión del modelo se construyó antes de hablar con los dueños, a partir de cómo suelen funcionar negocios de este tipo. El levantamiento confirmó la mayor parte, cerró una duda y dejó tres cosas que ese modelo no resolvía. Las tres ya están incorporadas; lo que sigue es cómo quedó cada una y qué decisión la sostiene.'),
  tabla([2300, 3530, 3530],
    ['Hallazgo', 'Cómo quedó en el modelo', 'La decisión que importa'],
    [
      [[fuerte('Algunos empleados trabajan en las dos tiendas')],
       [mono('USUARIO_TIENDA', T_MED), t(' resuelve el muchos a muchos entre usuario y tienda. La tienda desde la que se opera ahora se guarda en la sesión.', { size: 17 })],
       'Pertenecer a una tienda y estar operando desde ella son dos datos distintos. Crear dos usuarios para la misma persona habría partido en dos sus ventas y le habría dado dos PIN.'],
      [[fuerte('Dan crédito a los clientes')],
       [mono('CLIENTE', T_MED), t(' con límite de crédito, ', { size: 17 }), mono('PAGO_CREDITO', T_MED), t(' para los abonos, y la vista ', { size: 17 }), mono('v_cuentas_por_cobrar', T_MED), t(' con el saldo.', { size: 17 })],
       'El saldo no se guarda: se calcula. El abono va a la cuenta del cliente y no a una factura, y el que se paga en efectivo entra al arqueo de la caja.'],
      [[fuerte('Hacen rebajas por mayoreo')],
       [t('Columna ', { size: 17 }), mono('descuento', T_MED), t(' en cada línea de venta, con la restricción ', { size: 17 }), mono('CK_LINEA_DESCUENTO', T_MED), t('.', { size: 17 })],
       'La rebaja es sobre un producto, no sobre la boleta. En la cabecera habría que repartirla entre las líneas para saber cuánto se ganó con cada producto, y cualquier forma de repartirla sería inventada.'],
    ]),

  h3('Lo que el levantamiento dejó fuera de discusión'),
  vineta([fuerte('Precios diferenciados por tienda: ya no hace falta.'), t(' Era una duda abierta del modelo. Los dueños confirmaron que las dos tiendas cobran igual, así que el precio único se mantiene y la estructura adicional que se había previsto se descarta.')], 7),

  h3('Lo que sigue fuera del alcance'),
  vineta([fuerte('Compras a proveedor.'), t(' Una entrada registra el costo pero no a quién se le compró. No se preguntó por los proveedores en esta visita.')], 9),
  vineta([fuerte('Traspaso entre tiendas.'), t(' Se representa con dos movimientos sueltos, una salida y una entrada, sin vínculo entre sí. Tampoco se preguntó con qué frecuencia ocurre.')], 9),

  nota('Sobre el estado del modelo entidad-relación', [
    p(`Los diagramas y las tablas de este documento reflejan el modelo tal como está construido en db/schema.sql y verificado por sus ${CIFRAS.pruebasEsquema} pruebas. Antes de dibujar, el generador compara las entidades y relaciones del MER con las tablas y claves foráneas del esquema, y no escribe ningún diagrama si no coinciden.`,
      { size: 20, after: 0, line: 290 }),
  ]),

  h2('7.5  El modelo relacional'),
  p(`La traducción del modelo entidad-relación a tablas de SQL Server: ${ESQUEMA.size} tablas y ${TOTAL_FK} claves foráneas. La figura 6, en la página siguiente, no se dibujó a mano: se lee directamente de db/schema.sql, con todas las columnas, sus tipos y sus claves. Cada flecha sale de la fila de la columna que es clave foránea y apunta a la tabla que referencia.`),
  p('Algunas decisiones de la traducción que conviene tener presentes al leerla:'),
  ...[
    [fuerte('La especialización de USUARIO es una sola tabla.'), t(' Administrador y empleado comparten casi todo, así que se implementan en Usuario con la columna rol como discriminante. La restricción CK_USUARIO_CREDENCIALES exige a cada subtipo sus propias credenciales.')],
    [fuerte('Las entidades asociativas tienen clave compuesta.'), t(' Stock y USUARIO_TIENDA usan como clave primaria el par de claves foráneas: eso hace imposible por diseño que existan dos filas para el mismo par.')],
    [fuerte('La entidad débil hereda la clave de su dueña.'), t(' La clave de VENTA_LINEA es venta_id más el número de línea, y borrar la venta borra sus líneas (ON DELETE CASCADE).')],
    [fuerte('Los atributos derivados se calculan, no se capturan.'), t(' El saldo del cliente ni siquiera es columna: lo calcula una vista. El stock sí se guarda, como caché que mantiene un disparador, porque la pantalla de venta lo consulta en cada tecla.')],
    [fuerte('Los únicos opcionales son índices filtrados.'), t(' El código de producto, la cédula del cliente y el correo del usuario pueden faltar, pero si están no se repiten. En SQL Server una restricción UNIQUE común admitiría un solo NULL en toda la tabla.')],
  ].map((v) => vineta(v, 27)),
  p('El detalle de cada columna, con su tipo, si admite nulos y su valor por defecto, está en el Anexo A.'),
];

// ---- Anexo A. Diccionario de datos ------------------------------------------
// Se arma leyendo db/schema.sql, igual que la figura 6: si cambia una columna,
// el anexo cambia solo al regenerar el documento.
const descFk = (t, c) => {
  const fk = t.fks.find((f) => f.columnas.includes(c));
  return fk ? `→ ${fk.tabla}(${fk.ref[fk.columnas.indexOf(c)]})${fk.alBorrar ? ` ${fk.alBorrar}` : ''}` : '';
};
const anexo = [
  new Paragraph({
    heading: HeadingLevel.HEADING_1,
    pageBreakBefore: true,
    spacing: { before: 0, after: 60 },
    children: [
      new TextRun({ text: 'A. ', font: F_TIT, size: 32, color: AZUL, bold: true }),
      new TextRun({ text: 'Diccionario de datos', font: F_TIT, size: 32, color: TINTA, bold: true }),
    ],
  }),
  p(`Las ${ESQUEMA.size} tablas de la base, en el orden en que se crean. Se genera leyendo db/schema.sql al armar este documento, así que no puede contradecir a la base. Una columna sin la marca de nulo es NOT NULL.`,
    { size: 22, color: T_MED, line: 320 }),
  ...[...ESQUEMA.values()].flatMap((t) => [
    h2(t.nombre),
    tabla([2300, 1900, 800, 2560, 1800],
      ['Columna', 'Tipo', 'Nulo', 'Clave', 'Por defecto'],
      t.columnas.map((c) => [
        [mono(c.nombre, c.calculada ? T_MED : TINTA)],
        [mono(c.calculada ? `calculada${c.persistida ? ', persistida' : ''}` : c.tipo, T_MED)],
        c.nulo ? 'sí' : '',
        [mono([...marcas(t, c.nombre), descFk(t, c.nombre)].filter(Boolean).join(' '), AZUL)],
        [mono(c.identidad ? 'IDENTITY(1,1)' : (c.defecto ?? ''), T_MED)],
      ])),
    ...((t.checks.length || t.unicos.length) ? [p([
      new TextRun({ text: 'Restricciones: ', font: F_SANS, size: 17, color: T_BAJA, bold: true }),
      mono([...t.checks, ...t.unicos.map((u) => u.nombre + (u.filtro ? ` (WHERE ${u.filtro})` : ''))].join(' · '), T_MED),
    ], { after: 120 })] : []),
  ]),
];

// ---- 8. Estado --------------------------------------------------------------
const s8 = [
  h1(8, 'Estado y plan de trabajo'),
  p([new TextRun({ text: 'Sección añadida. ', font: F_SANS, size: 20, color: CIRUELA, bold: true }),
     t('Documenta qué está construido y verificado, y qué queda pendiente.', { size: 21, color: T_MED })],
    { line: 320 }),

  tabla([3400, 3000, 2960],
    ['Componente', 'Estado', 'Verificación'],
    [
      [[fuerte('Levantamiento de requerimientos')], 'Realizado', 'ficha de la visita incompleta'],
      [[fuerte('Modelo conceptual y reglas')], 'Validado con los dueños', `${PROCESOS.length} procesos, ${REGLAS.length} reglas`],
      [[fuerte('Modelo entidad-relación')], 'Completo, con los cambios del levantamiento', `${CIFRAS.entidades} entidades, diagramas verificados`],
      [[fuerte('Modelo relacional y diccionario')], 'Completos', 'se generan desde db/schema.sql'],
      [[fuerte('Base de datos (SQL Server)')], 'Implementada', [mono(`${CIFRAS.pruebasEsquema} pruebas automatizadas`, T_MED)]],
      [[fuerte('API')], `Implementada: ${CIFRAS.endpoints} rutas`, [mono(`${CIFRAS.pruebasApi} pruebas automatizadas`, T_MED)]],
      [[fuerte('Autenticación y permisos')], 'Implementada', 'PIN, contraseña, sesiones revocables, límite de intentos'],
      [[fuerte('Sincronización sin conexión')], 'Implementada', 'reenvíos sin duplicar'],
      [[fuerte('Crédito y abonos')], 'Implementado', 'límite controlado por la base'],
      [[fuerte('Punto de venta (tablet)')], 'Implementado', 'vende con y sin señal; crédito, abonos y caja'],
      [[fuerte('Panel de administración')], 'Implementado', 'las dos tiendas; reportes, anulaciones, auditoría de inventario'],
    ]),

  p('Durante esta etapa la base de datos se migró de PostgreSQL a SQL Server. Las pruebas se portaron junto con ella y todas pasan sobre la versión actual.'),

  nota('Sobre la verificación', [
    p(`Las ${CIFRAS.pruebas} pruebas no comprueban solamente que el código corra: comprueban las reglas de negocio. Que una venta no pueda aumentar el stock, que el historial no se pueda alterar, que reenviar una operación no la duplique, que no se pueda fiar por encima del límite, que una venta a medias no deje rastros. Ese enfoque ya encontró errores reales: un cálculo de ganancia inflado al triple por una suma mal agrupada; un reporte diario que contaba las ventas de la tarde en el día siguiente, porque la base guarda la hora universal y Nicaragua está seis horas atrás, y una validación que rechazaba rebajas con centavos porque comparaba importes en punto flotante sin redondear (0.30000000000000004 contra 0.3).`,
      { size: 20, after: 0, line: 290 }),
  ]),

  h3('Próximos pasos'),
  ...[
    'Completar la ficha de datos que la visita dejó sin llenar: tiendas, empleados y cómo llevan hoy la cuenta de quién debe.',
    'Dar de alta las tablets como dispositivos, para que el panel muestre cuándo sincronizó cada una.',
    'Abrir la caja sin conexión: hoy la apertura exige señal.',
    'Publicar el sistema con https, que es lo que permite instalar el punto de venta en la tablet y abrirlo sin señal.',
    'Carga inicial y codificación del catálogo: los dueños no saben cuántos productos manejan, y es el mayor riesgo para poner el sistema en marcha.',
    'Prueba en tienda en paralelo con el cuaderno, hasta que los dueños confíen en el sistema.',
  ].map((o) => numerada(o, 11)),
];

// =============================================================================
// ENSAMBLADO
// =============================================================================
const MARGEN_V = { top: 1440, bottom: 1440, left: 1440, right: 1440 };
const MARGEN_H = { top: 720, bottom: 720, left: 720, right: 720 };
const VERTICAL = { size: { width: 12240, height: 15840 }, margin: MARGEN_V };
const APAISADA = {
  size: { width: 12240, height: 15840, orientation: PageOrientation.LANDSCAPE },
  margin: MARGEN_H,
};

const epig = (negrita, resto) => [
  new TextRun({ text: negrita, font: F_SANS, size: 18, color: T_MED, bold: true }),
  new TextRun({ text: resto, font: F_TEXTO, size: 18, color: T_BAJA }),
];

const doc = new Document({
  creator: 'Proyecto Ferreplast',
  title: 'Ferreplast — Documento de presentación de proyecto',
  description: 'Antecedentes, justificación, modelo conceptual y modelo entidad-relación',
  numbering: {
    config: [
      {
        reference: 'vinetas',
        levels: [{
          level: 0, format: LevelFormat.BULLET, text: '\u2022', alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 400, hanging: 220 } } },
        }],
      },
      {
        reference: 'numerada',
        levels: [{
          level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 400, hanging: 220 } } },
        }],
      },
    ],
  },
  sections: [
    { properties: { page: VERTICAL },
      children: [...portada(), ...indice, ...s1, ...s2, ...s3, ...s4, ...s5, ...s6, ...s7a] },

    { properties: { page: APAISADA },
      children: figura('08-proceso-venta.svg', PX_H, Math.round(PX_H * 500 / 1140),
        epig('Figura 1 — El proceso de venta sobre el modelo. ',
          'Los dos primeros pasos sólo leen. El paso 3 no escribe nada: hasta que no se cobra, la venta no existe. Los pasos 4 y 5 escriben, y lo hacen en una sola operación indivisible (regla RN-23). Los movimientos de inventario no los envía la tablet: los deriva el servidor de las líneas de la venta, con lo que resulta imposible que exista una venta sin su descuento de stock.'),
        2200) },

    { properties: { page: VERTICAL }, children: [...s7b] },

    { properties: { page: APAISADA },
      children: [
        ...figura('00-modelo-completo.svg', PX_H, alto('00-modelo-completo.svg'),
          epig('Figura 2 — Modelo entidad-relación completo. ',
            `Las ${CIFRAS.entidades} entidades y las ${CIFRAS.relaciones} relaciones, una por clave foránea. En ámbar, las construcciones del modelo extendido: la especialización de USUARIO en ADMINISTRADOR y EMPLEADO, la entidad débil VENTA_LINEA, la relación recursiva de CATEGORIA y las entidades asociativas STOCK y USUARIO_TIENDA. En verde, los atributos que se calculan en lugar de capturarse. Por su densidad, esta figura sirve para ver la forma general; las tres siguientes lo presentan en detalle legible.`),
          2600),
        ...figura('01-vista-estructura.svg', PX_H, alto('01-vista-estructura.svg'),
          epig('Figura 3 — Vista de estructura. ',
            'El negocio es la raíz de la que cuelgan tiendas, usuarios y clientes. El catálogo es único para las dos tiendas: lo que varía por tienda es el STOCK, que resuelve la relación muchos a muchos entre tienda y producto. USUARIO_TIENDA resuelve la otra: un empleado puede trabajar en una tienda o en las dos. La flecha que sale y vuelve a CATEGORIA es la relación recursiva que arma la jerarquía de rubros.'),
          2200, true),
        ...figura('02-vista-operacion.svg', PX_H, alto('02-vista-operacion.svg'),
          epig('Figura 4 — Vista de operación. ',
            'Las entidades punteadas se definen en la figura 3 y aquí sirven de contexto. VENTA_LINEA lleva doble borde por ser entidad débil, y su relación con VENTA se dibuja con doble línea por ser identificadora. Una venta fiada apunta al CLIENTE; sus abonos van a PAGO_CREDITO y, si son en efectivo, a la CAJA del turno.'),
          2200, true),
        ...figura('09-vista-acceso.svg', PX_H, alto('09-vista-acceso.svg'),
          epig('Figura 5 — Vista de acceso y sincronización. ',
            'Cada SESION pertenece a un usuario y fija desde qué tienda opera, que es lo que decide qué datos puede tocar. INTENTO_LOGIN no tiene clave foránea al usuario a propósito: tiene que poder registrar un intento con un correo que no existe. Cada DISPOSITIVO deja en SYNC_LOG cuánto envió, cuánto se aceptó y cuánto era repetido.'),
          2200, true),
      ] },

    { properties: { page: VERTICAL }, children: [...s7c] },

    { properties: { page: APAISADA },
      children: figura('10-modelo-relacional.svg', PX_H, alto('10-modelo-relacional.svg'),
        epig('Figura 6 — Modelo relacional. ',
          `Las ${ESQUEMA.size} tablas con todas sus columnas, leídas de db/schema.sql. PK marca la clave primaria, FK la clave foránea y UQ un valor único; NULL indica que la columna admite nulos. Cada flecha sale de la columna clave foránea y apunta a la tabla referenciada; en ámbar, las que borran en cascada.`),
        2900) },

    { properties: { page: VERTICAL }, children: [...s8, ...anexo] },
  ],
});

const salida = join(AQUI, 'Ferreplast - Documento de presentacion.docx');
const buffer = await Packer.toBuffer(doc);
writeFileSync(salida, buffer);
console.log(`Generado: ${salida}  (${(buffer.length / 1024).toFixed(0)} KB)`);
