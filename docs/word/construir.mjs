// =============================================================================
// Genera el documento Word del proyecto Ferreplast.
//
// Los diagramas son SVG y Word no los inserta bien, asi que se rasterizan a PNG
// con resvg antes de incrustarlos. Las figuras van en paginas apaisadas: a lo
// ancho de una pagina vertical el texto de los diagramas quedaria ilegible.
//
// Uso:  node construir.mjs
// =============================================================================

import { readFileSync, writeFileSync } from 'node:fs';
import { Resvg } from '@resvg/resvg-js';
import {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
  Table, TableRow, TableCell, WidthType, ShadingType, BorderStyle,
  ImageRun, PageBreak, PageOrientation, LevelFormat, convertInchesToTwip,
} from 'docx';

const DIAG = 'C:/dev/ferreplast/docs/diagramas';

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

// =============================================================================
// CONTENIDO
// =============================================================================

// ---- Portada ----------------------------------------------------------------
const portada = [
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
      ['Entidades del modelo', '12', 'Más 3 subtipos de la especialización'],
      ['Relaciones', '22', 'Más una jerarquía ISA'],
      ['Procesos definidos', '11', 'Ninguno estaba formalizado'],
      ['Reglas de negocio', '29', '26 impuestas por la base de datos'],
      ['Levantamiento', 'Realizado', 'Confirma el diseño; exige 3 cambios'],
      ['Estado', 'Base de datos y API construidas', '66 pruebas automatizadas'],
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
    p('El levantamiento de requerimientos ya se realizó y sus resultados están incorporados en la sección 2. Confirmó buena parte del diseño, cerró una duda abierta y reveló tres cosas que el modelo todavía no resuelve; esas tres se detallan en el apartado 7.4.',
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
  p('Se visitó a los dueños con una guía de preguntas. Lo que sigue es lo que respondieron y lo que cada respuesta implica para el sistema. Cinco respuestas confirman decisiones de diseño ya tomadas; tres obligan a modificar el modelo.'),
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
       'No estaba modelado. El descuento existe como monto suelto en la venta, sin regla por cantidad.'],
      [[fuerte('Crédito a clientes')], 'Sí, los negocios dan fiado.',
       'No estaba modelado. Es el cambio más grande que exige el levantamiento.'],
      [[fuerte('Formas de pago')], 'Sólo efectivo.',
       'Simplifica el modelo. El fiado no es otra forma de pago: es una venta que se cobra después, también en efectivo.'],
      [[fuerte('Cierre de caja')], 'Cuentan el dinero a mano y lo verifican contra el cuaderno.',
       'Confirma el proceso PR-05 tal como se definió, incluido el contraste entre lo esperado y lo contado.'],
      [[fuerte('Empleados')], 'No saben cuántos son. Cada tienda tiene los suyos, pero algunos trabajan en las dos.',
       'Rompe el modelo actual, que ata cada empleado a una sola tienda.'],
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
  vineta([fuerte('Técnica.'), t(' El esquema de base de datos y la interfaz de sincronización ya están construidos y verificados con 66 pruebas automatizadas. No es una propuesta teórica.')], 5),
  vineta([fuerte('Económica.'), t(' El hardware necesario son dos tablets de gama básica. La base de datos y el alojamiento tienen capa gratuita suficiente para dos tiendas.')], 5),
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
      ['Panel consolidado de las dos tiendas', 'Contabilidad general y balances'],
      ['Avisos de stock bajo', 'Venta por internet o catálogo público'],
      ['Roles diferenciados de empleado y administrador', 'Lector de código de barras (previsto, no incluido)'],
    ]),

  h3('Limitaciones conocidas'),
  vineta([fuerte('El crédito a clientes está confirmado pero no construido.'), t(' Los dueños dan fiado, así que el sistema lo necesita. Hoy puede registrar que una venta fue a crédito, pero no quién debe ni cuánto. Es lo primero a incorporar tras el levantamiento.')], 6),
  vineta([fuerte('Las rebajas por mayoreo no tienen regla.'), t(' Se hacen, y el sistema admite un descuento en la venta, pero no la regla por cantidad que lo justifica.')], 6),
  vineta([fuerte('Un empleado sólo puede estar en una tienda.'), t(' El levantamiento reveló que algunos trabajan en las dos. El modelo actual no lo permite.')], 6),
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

const s6 = [
  h1(6, 'Modelo conceptual'),
  p('El punto de partida real de este proyecto: el negocio no tiene procesos definidos. Nadie escribió nunca cómo se registra una venta o qué se hace cuando llega mercadería. Antes de modelar datos hay que definir esos procesos, porque son ellos los que dictan las reglas, y las reglas las que dictan el modelo.',
    { size: 22, color: T_MED, line: 320 }),

  h2('6.1  Qué significa que no haya procesos definidos'),
  p('Las tiendas funcionan, así que algo se hace. Pero lo que se hace es práctica heredada, no procedimiento: cada persona lo ejecuta a su manera, no está escrito, y no produce un registro consultable. Un proceso definido tiene disparador, pasos, un responsable y un rastro que queda. Nada de eso existe hoy.'),
  p('La consecuencia práctica es que no se puede automatizar lo que no está definido. Si dos empleados anotan la venta de manera distinta, no hay forma de programar el registro de una venta. Por eso el primer trabajo del proyecto no fue técnico: fue proponer los procesos que faltaban.'),

  h2('6.2  Inventario de procesos'),
  p('Se identificaron once procesos necesarios para operar las dos tiendas. Ninguno estaba formalizado; nueve existen como práctica informal y dos directamente no existen.'),
  tabla([900, 2100, 3180, 3180],
    ['N.º', 'Proceso', 'Cómo está hoy', 'Qué falta'],
    [
      [[cod('PR-01')], [fuerte('Registro de venta')], 'Se anota en un cuaderno, sin formato fijo', 'Formato único, cálculo del total, descuento del stock'],
      [[cod('PR-02')], [fuerte('Recepción de mercadería')], 'Se guarda y se recuerda; no siempre se anota', 'Registro de entrada con costo, para valorizar el inventario'],
      [[cod('PR-03')], [fuerte('Alta y codificación de producto')], 'Cada artículo se nombra como se lo conoce', 'Código único, unidad de medida, categoría y precio'],
      [[cod('PR-04')], [fuerte('Fijación y cambio de precio')], 'El precio vive en la memoria del dueño', 'Precio registrado, y precio histórico de cada venta'],
      [[cod('PR-05')], [fuerte('Cierre de caja')], 'Se cuenta el efectivo, sin compararlo contra lo esperado', 'Monto esperado calculado y descuadre detectado'],
      [[cod('PR-06')], [fuerte('Conteo físico y ajuste')], 'Esporádico; las diferencias se asumen sin explicación', 'Ajuste registrado como movimiento, con motivo'],
      [[cod('PR-07')], [fuerte('Registro de merma')], [new TextRun({ text: 'NO EXISTE. ', font: F_SANS, size: 16, color: AMBAR, bold: true }), t('Lo roto o vencido se descarta sin registro', { size: 17 })], 'Distinguir la pérdida de la venta: una es costo, la otra ingreso'],
      [[cod('PR-08')], [fuerte('Reposición de inventario')], 'Se compra cuando se nota que falta', 'Umbral mínimo por producto y aviso anticipado'],
      [[cod('PR-09')], [fuerte('Control de acceso del personal')], [new TextRun({ text: 'NO EXISTE. ', font: F_SANS, size: 16, color: AMBAR, bold: true }), t('Cualquiera anota en el cuaderno', { size: 17 })], 'Identificación del responsable de cada operación'],
      [[cod('PR-10')], [fuerte('Supervisión consolidada')], 'Visitando ambas tiendas o llamando por teléfono', 'Vista única de las dos tiendas con ganancia real'],
      [[cod('PR-11')], [fuerte('Sincronización entre tiendas')], [new TextRun({ text: 'NO APLICA. ', font: F_SANS, size: 16, color: T_BAJA, bold: true }), t('No hay nada que sincronizar en papel', { size: 17 })], 'Proceso nuevo que introduce el sistema'],
    ]),

  h2('6.3  Procesos definidos'),
  p('Definición formal de los cinco procesos centrales. Cada ficha indica qué lo dispara, los pasos que lo componen y las reglas de negocio que genera. Los seis restantes siguen la misma estructura y se resumen en la tabla de reglas del apartado 6.4.'),

  ...ficha('PR-01', 'Registro de venta',
    'Se dispara cuando un cliente decide llevar mercadería.',
    ['El empleado se identifica con su PIN en la tablet de su tienda.',
     'Busca cada producto por nombre o código y ve el precio y las existencias.',
     'Arma el pedido indicando la cantidad de cada artículo.',
     'Cobra y elige la forma de pago.',
     'El sistema registra la venta, su detalle y la salida de stock, todo junto.'],
    [['RN-08', 'Una venta necesita al menos una línea de detalle.'],
     ['RN-09', 'El total es el subtotal menos el descuento, sin excepción.'],
     ['RN-10', 'El precio y el costo se copian al vender y ya no cambian.'],
     ['RN-11', 'El número de comprobante es único dentro de la tienda.'],
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
     'Durante el turno, las ventas en efectivo se asocian a esa caja.',
     'Al cerrar, el sistema calcula cuánto efectivo debería haber.',
     'El empleado cuenta el dinero real y lo ingresa.',
     'El sistema registra la diferencia entre lo esperado y lo contado.'],
    [['RN-12', 'Una tienda no puede tener dos cajas abiertas al mismo tiempo.'],
     ['RN-13', 'El descuadre se calcula, nunca se escribe a mano.'],
     ['RN-14', 'Una caja no puede cerrarse sin declarar el efectivo contado.'],
     ['RN-25', 'Se conservan por separado lo esperado y lo contado, para poder auditar cuál estaba mal.']], 22),

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
     ['RN-29', 'Se registra cuándo sincronizó cada dispositivo por última vez.']], 24),

  h2('6.4  Reglas de negocio'),
  p('Las reglas derivadas de los procesos anteriores, con el lugar donde cada una se hace cumplir. Que una regla esté en la base de datos significa que se cumple aunque el programa tenga un error o alguien se conecte directamente a la base; que esté en la aplicación significa que depende del programa.'),
];

const BD  = () => [new TextRun({ text: 'BD', font: F_SANS, size: 16, color: AZUL, bold: true })];
const APP = () => [new TextRun({ text: 'APP', font: F_SANS, size: 16, color: AMBAR, bold: true })];

const REGLAS = [
  ['RN-01', 'Un producto pertenece al negocio, no a una tienda', 'PR-03', BD, 'productos.negocio_id'],
  ['RN-02', 'El código de producto es único en el negocio', 'PR-03', BD, 'uq_productos_codigo'],
  ['RN-03', 'El stock es por tienda: una sola fila por par', 'PR-02', BD, 'PK (tienda_id, producto_id)'],
  ['RN-04', 'El stock se deduce sumando los movimientos', 'PR-06', BD, 'disparador de stock'],
  ['RN-05', 'Todo cambio de stock queda registrado con responsable y momento', 'PR-02', BD, 'movimientos_inventario'],
  ['RN-06', 'Una venta o merma resta; una entrada o devolución suma', 'PR-01', BD, 'chk_signo_segun_tipo'],
  ['RN-07', 'El historial de inventario es inalterable', 'PR-06', BD, 'trg_movimientos_inmutables'],
  ['RN-08', 'Una venta necesita al menos una línea', 'PR-01', APP, 'validación de la API'],
  ['RN-09', 'Total = subtotal menos descuento', 'PR-01', BD, 'chk_total_coherente'],
  ['RN-10', 'El precio y el costo se congelan al vender', 'PR-04', BD, 'venta_lineas'],
  ['RN-11', 'El número de venta es único dentro de la tienda', 'PR-01', BD, 'uq_ventas_numero'],
  ['RN-12', 'Una tienda no puede tener dos cajas abiertas', 'PR-05', BD, 'uq_caja_abierta_por_tienda'],
  ['RN-13', 'El descuadre de caja se calcula, no se captura', 'PR-05', BD, 'columna generada'],
  ['RN-14', 'No se cierra caja sin declarar el efectivo contado', 'PR-05', BD, 'chk_cierre_completo'],
  ['RN-15', 'El empleado opera su tienda; el administrador ve ambas', 'PR-09', BD, 'usuarios.rol, tienda_id'],
  ['RN-16', 'Las credenciales dependen del rol', 'PR-09', BD, 'chk_credenciales'],
  ['RN-17', 'No se borra un producto con historial', 'PR-03', BD, 'FK RESTRICT'],
  ['RN-18', 'Borrar una venta borra su detalle', 'PR-01', BD, 'FK CASCADE'],
  ['RN-19', 'El dato histórico sobrevive a la baja del empleado', 'PR-09', BD, 'FK SET NULL'],
  ['RN-20', 'Reenviar una operación no la duplica', 'PR-11', BD, 'PK del dispositivo'],
  ['RN-21', 'Las categorías forman jerarquía', 'PR-03', BD, 'categorias.padre_id'],
  ['RN-22', 'Se avisa cuando el stock baja del mínimo', 'PR-08', BD, 'v_alertas_stock'],
  ['RN-23', 'Venta, detalle y stock se guardan juntos o nada', 'PR-01', APP, 'transacción'],
  ['RN-24', 'El costo se guarda al recibir la mercadería', 'PR-02', BD, 'movimientos.costo_unitario'],
  ['RN-25', 'Se conservan por separado lo esperado y lo contado', 'PR-05', BD, 'cajas'],
  ['RN-26', 'Los errores se corrigen con un ajuste, no reescribiendo', 'PR-06', BD, "tipo 'ajuste'"],
  ['RN-27', 'Un movimiento de cantidad cero no se admite', 'PR-06', BD, 'chk_cantidad_no_cero'],
  ['RN-28', 'Un registro con error no bloquea el resto del envío', 'PR-11', APP, 'proceso por elemento'],
  ['RN-29', 'Se registra la última sincronización de cada dispositivo', 'PR-11', BD, 'dispositivos, sync_log'],
];

s6.push(
  tabla([800, 3400, 900, 900, 3360],
    ['N.º', 'Regla', 'Proceso', 'Dónde', 'Mecanismo'],
    REGLAS.map(([n, regla, proc, donde, mec]) => [
      [cod(n)], regla, [mono(proc, T_MED)], donde(), [mono(mec)],
    ])),
  nota('Sobre las tres reglas que vive la aplicación', [
    p('RN-08, RN-23 y RN-28 no las impone la base de datos. Es una debilidad conocida y vale reconocerla antes de que la señalen: si alguien se conectara directamente a la base podría insertar una venta sin líneas. Se podría cerrar con una restricción diferida, a costa de complicar la carga inicial de datos. Se dejó así deliberadamente, y queda anotado como una decisión, no como un descuido.',
      { size: 20, after: 0, line: 290 }),
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

const s7b = [
  h2('7.2  Trazabilidad del modelo conceptual al modelo de datos'),
  p('Proceso por proceso, las entidades que lo sostienen. Ninguna entidad del modelo existe porque sí: todas aparecen porque algún proceso las necesita.'),
  tabla([2400, 4560, 2400],
    ['Proceso', 'Entidades que intervienen', 'Reglas'],
    [
      [[fuerte('PR-01 Registro de venta')], [mono('VENTA, VENTA_LINEA, MOVIMIENTO_INVENTARIO, STOCK, PRODUCTO, USUARIO, TIENDA, CAJA', T_MED)], [mono('RN-06, 08, 09, 10, 11, 18, 23', T_MED)]],
      [[fuerte('PR-02 Recepción de mercadería')], [mono('MOVIMIENTO_INVENTARIO, STOCK, PRODUCTO, TIENDA, USUARIO', T_MED)], [mono('RN-03, 05, 06, 24', T_MED)]],
      [[fuerte('PR-03 Alta de producto')], [mono('PRODUCTO, CATEGORIA, NEGOCIO', T_MED)], [mono('RN-01, 02, 17, 21', T_MED)]],
      [[fuerte('PR-04 Fijación de precio')], [mono('PRODUCTO, VENTA_LINEA', T_MED)], [mono('RN-10', T_MED)]],
      [[fuerte('PR-05 Cierre de caja')], [mono('CAJA, VENTA, USUARIO, TIENDA', T_MED)], [mono('RN-12, 13, 14, 25', T_MED)]],
      [[fuerte('PR-06 Conteo y ajuste')], [mono('MOVIMIENTO_INVENTARIO, STOCK', T_MED)], [mono('RN-04, 07, 26, 27', T_MED)]],
      [[fuerte('PR-07 Registro de merma')], [mono('MOVIMIENTO_INVENTARIO, STOCK', T_MED)], [mono('RN-05, 06', T_MED)]],
      [[fuerte('PR-08 Reposición')], [mono('STOCK, PRODUCTO, TIENDA', T_MED)], [mono('RN-22', T_MED)]],
      [[fuerte('PR-09 Control de acceso')], [mono('USUARIO, TIENDA, NEGOCIO', T_MED)], [mono('RN-15, 16, 19', T_MED)]],
      [[fuerte('PR-10 Supervisión consolidada')], [mono('VENTA, VENTA_LINEA, STOCK, PRODUCTO, TIENDA', T_MED)], [mono('RN-10, 22', T_MED)]],
      [[fuerte('PR-11 Sincronización')], [mono('DISPOSITIVO, SYNC_LOG, MOVIMIENTO_INVENTARIO, VENTA', T_MED)], [mono('RN-04, 20, 28, 29', T_MED)]],
    ]),
  p('La correspondencia se cumple en los dos sentidos. Las 12 entidades del modelo aparecen al menos una vez en la columna del medio: no hay ninguna que no responda a un proceso. Y los 11 procesos tienen entidades que los sostienen: ninguno quedó sin modelar.'),
  h2('7.3  El modelo entidad-relación'),
  p('El modelo completo se presenta en tres figuras. La figura 2 muestra las 12 entidades y las 22 relaciones juntas; por su densidad conviene para ver la forma general. Las figuras 3 y 4 parten ese mismo modelo en dos vistas legibles: la estructura del negocio y el catálogo, y la operación de venta. Las tres están en las páginas siguientes.'),
];

const s7c = [
  h2('7.4  Cambios que exige el levantamiento'),
  p('El modelo presentado hasta aquí se construyó antes de hablar con los dueños, a partir de cómo suelen funcionar negocios de este tipo. El levantamiento confirmó la mayor parte, cerró una duda y dejó tres cosas que el modelo todavía no resuelve. Reconocerlas es parte del trabajo.'),
  tabla([2500, 3430, 3430],
    ['Hallazgo', 'Qué exige el modelo', 'Alcance del cambio'],
    [
      [[fuerte('Algunos empleados trabajan en las dos tiendas')],
       'Una relación muchos a muchos entre USUARIO y TIENDA, con una entidad intermedia de asignación.',
       'Modificación, no adición. Hoy cada empleado cuelga de una sola tienda y la restricción de credenciales exige esa tienda. Ambas cosas dejan de valer.'],
      [[fuerte('Dan crédito a los clientes')],
       'Una entidad CLIENTE y el registro de cobros, para saber quién debe y cuánto queda pendiente tras cada pago parcial.',
       'La adición más grande. Sin esto el sistema registra que una venta fue fiada pero no puede decir a quién.'],
      [[fuerte('Hacen rebajas por mayoreo')],
       'Una regla de descuento por cantidad, aplicada en la línea de venta y no como monto suelto en la cabecera.',
       'Adición acotada. El descuento ya existe; falta la regla que lo justifica y lo hace reproducible.'],
    ]),

  h3('Lo que el levantamiento dejó fuera de discusión'),
  vineta([fuerte('Precios diferenciados por tienda: ya no hace falta.'), t(' Era una duda abierta del modelo. Los dueños confirmaron que las dos tiendas cobran igual, así que el precio único se mantiene y la estructura adicional que se había previsto se descarta.')], 7),

  h3('Lo que sigue fuera del alcance'),
  vineta([fuerte('Compras a proveedor.'), t(' Una entrada registra el costo pero no a quién se le compró. No se preguntó por los proveedores en esta visita.')], 9),
  vineta([fuerte('Traspaso entre tiendas.'), t(' Se representa con dos movimientos sueltos, una salida y una entrada, sin vínculo entre sí. Tampoco se preguntó con qué frecuencia ocurre.')], 9),

  nota('Sobre el estado del modelo entidad-relación', [
    p('Los diagramas y las tablas de este documento reflejan el modelo tal como está construido y verificado hoy. Los tres cambios de arriba están identificados pero todavía no incorporados, y así se presentan a propósito: un modelo que dice ser una cosa y es otra vale menos que uno que declara con precisión hasta dónde llega.',
      { size: 20, after: 0, line: 290 }),
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
      [[fuerte('Modelo conceptual y reglas')], 'Validado con los dueños', 'tres cambios pendientes (7.4)'],
      [[fuerte('Modelo entidad-relación')], 'Completo', 'documentado y diagramado'],
      [[fuerte('Esquema de base de datos')], 'Implementado', [mono('28 pruebas automatizadas', T_MED)]],
      [[fuerte('Interfaz de sincronización')], 'Implementada', [mono('38 pruebas automatizadas', T_MED)]],
      [[fuerte('Autenticación')], 'Pendiente', '—'],
      [[fuerte('Punto de venta')], 'Pendiente', '—'],
      [[fuerte('Panel de administración')], 'Pendiente', '—'],
    ]),

  nota('Sobre la verificación', [
    p('Las 66 pruebas no comprueban solamente que el código corra: comprueban las reglas de negocio. Que una venta no pueda aumentar el stock, que el historial no se pueda alterar, que reenviar una operación no la duplique, que una venta a medias no deje rastros. Ese enfoque ya encontró dos errores reales: un cálculo de ganancia inflado al triple por una suma mal agrupada, y una prueba que sólo fallaba entre medianoche y las dos de la madrugada.',
      { size: 20, after: 0, line: 290 }),
  ]),

  h3('Próximos pasos'),
  ...[
    'Incorporar al modelo los tres cambios del apartado 7.4: empleados en varias tiendas, clientes con crédito y descuento por mayoreo.',
    'Completar la ficha de datos que la visita dejó sin llenar, sobre todo cómo llevan hoy la cuenta de quién debe.',
    'Autenticación, antes de construir las pantallas: hacerlo después obliga a rehacer parte del cliente.',
    'Punto de venta con funcionamiento sin conexión.',
    'Panel de administración consolidado.',
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
      children: [...portada, ...indice, ...s1, ...s2, ...s3, ...s4, ...s5, ...s6, ...s7a] },

    { properties: { page: APAISADA },
      children: figura('08-proceso-venta.svg', PX_H, Math.round(PX_H * 500 / 1140),
        epig('Figura 1 — El proceso de venta sobre el modelo. ',
          'Los tres primeros pasos sólo leen. El paso 3 no escribe nada: hasta que no se cobra, la venta no existe. Los pasos 4 y 5 escriben, y lo hacen en una sola operación indivisible (regla RN-23). Los movimientos de inventario no los envía la tablet: los deriva el servidor de las líneas de la venta, con lo que resulta imposible que exista una venta sin su descuento de stock.'),
        2200) },

    { properties: { page: VERTICAL }, children: [...s7b] },

    { properties: { page: APAISADA },
      children: [
        ...figura('00-modelo-completo.svg', PX_H, Math.round(PX_H * 1240 / 1840),
          epig('Figura 2 — Modelo entidad-relación completo. ',
            'Las 12 entidades y las 22 relaciones. En ámbar, las construcciones del modelo extendido: la especialización de USUARIO, la entidad débil VENTA_LINEA, la relación recursiva de CATEGORIA y la entidad asociativa STOCK. En verde, los atributos que se calculan en lugar de capturarse. Por su densidad, esta figura sirve para ver la forma general del modelo; las dos siguientes lo presentan en detalle legible.'),
          2400),
        ...figura('01-vista-estructura.svg', PX_H, Math.round(PX_H * 760 / 1180),
          epig('Figura 3 — Vista de estructura. ',
            'El negocio es la raíz de la que cuelgan tiendas, usuarios, categorías y productos. El catálogo es único para las dos tiendas: lo que varía por tienda es el STOCK, que en ámbar resuelve la relación muchos a muchos entre tienda y producto. La flecha que sale y vuelve a CATEGORIA es la relación recursiva que arma la jerarquía de rubros.'),
          2200, true),
        ...figura('02-vista-operacion.svg', PX_H, Math.round(PX_H * 720 / 1180),
          epig('Figura 4 — Vista de operación. ',
            'Las entidades punteadas ya se definieron en la figura 3 y aquí sirven de contexto. VENTA_LINEA lleva doble borde por ser entidad débil, y su relación con VENTA se dibuja con doble línea por ser identificadora. USUARIO se conecta dos veces a CAJA: son dos roles distintos de la misma entidad, no dos relaciones repetidas.'),
          2200, true),
      ] },

    { properties: { page: VERTICAL }, children: [...s7c, ...s8] },
  ],
});

const salida = 'Ferreplast - Documento de presentacion.docx';
const buffer = await Packer.toBuffer(doc);
writeFileSync(salida, buffer);
console.log(`Generado: ${salida}  (${(buffer.length / 1024).toFixed(0)} KB)`);
