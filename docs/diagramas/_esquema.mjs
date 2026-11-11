// =============================================================================
// Lee db/schema.sql y devuelve las tablas con sus columnas y claves.
//
// El modelo relacional y el diccionario de datos del Word salen de aca, no de
// una lista escrita a mano: asi no pueden describir una tabla distinta de la
// que existe. Si se agrega una columna al esquema, aparece sola la proxima vez
// que se corre `npm run diagramas` o `npm run word`.
//
// No es un analizador de T-SQL general: entiende el formato de este archivo
// (una columna por linea, con cuatro espacios de sangria y nombre en
// minusculas; restricciones con CONSTRAINT). Si algo no encaja, falla en vez
// de devolver un modelo incompleto.
// =============================================================================

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const aqui = dirname(fileURLToPath(import.meta.url));
const RUTA = join(aqui, '..', '..', 'db', 'schema.sql');

const sinComentario = (l) => l.replace(/--.*$/, '').replace(/\s+$/, '');
const lista = (s) => s.split(',').map((x) => x.trim());

export function leerEsquema(ruta = RUTA) {
  const sql = readFileSync(ruta, 'utf8').replace(/\r\n/g, '\n');
  const tablas = new Map();

  for (const m of sql.matchAll(/^CREATE TABLE (\w+) \(\n([\s\S]*?)\n\);/gm)) {
    const [, nombre, cuerpo] = m;
    const t = { nombre, columnas: [], pk: [], fks: [], unicos: [], checks: [] };
    const lineas = cuerpo.split('\n').map(sinComentario).filter((l) => l.trim());

    for (const l of lineas) {
      const col = l.match(/^ {4}([a-z_][a-z0-9_]*)\s+(.*?),?$/);
      if (col) {
        const [, cn, resto] = col;
        const calculada = /^AS\s*\(/.test(resto);
        const tipo = calculada ? 'calculada' : resto.match(/^(\w+(?:\([^)]*\))?)/)[1];
        const c = {
          nombre: cn,
          tipo,
          nulo: !calculada && !/NOT NULL|PRIMARY KEY/.test(resto),
          identidad: /IDENTITY/.test(resto),
          defecto: (resto.match(/DEFAULT\s+('[^']*'|[\w.]+\(\)|[\w.]+)/) ?? [])[1] ?? null,
          calculada,
          persistida: /PERSISTED/.test(resto),
        };
        t.columnas.push(c);
        if (/PRIMARY KEY/.test(resto)) t.pk.push(cn);
        continue;
      }
      const pk = l.match(/CONSTRAINT \w+ PRIMARY KEY \(([^)]+)\)/);
      if (pk) t.pk.push(...lista(pk[1]));
      const uq = l.match(/CONSTRAINT (\w+) UNIQUE \(([^)]+)\)/);
      if (uq) t.unicos.push({ nombre: uq[1], columnas: lista(uq[2]), filtro: null });
      const ck = l.match(/CONSTRAINT (CK_\w+) CHECK/);
      if (ck) t.checks.push(ck[1]);
    }
    for (const fk of cuerpo.matchAll(/CONSTRAINT (\w+)\s+FOREIGN KEY \(([^)]+)\)\s+REFERENCES (\w+)\(([^)]+)\)( ON DELETE \w+)?/g)) {
      t.fks.push({ nombre: fk[1], columnas: lista(fk[2]), tabla: fk[3], ref: lista(fk[4]),
                   alBorrar: fk[5] ? fk[5].trim().replace('ON DELETE ', '') : null });
    }
    if (!t.columnas.length || !t.pk.length) {
      throw new Error(`No se pudo leer la tabla ${nombre}: ${t.columnas.length} columnas, PK ${t.pk.join(',') || 'ausente'}`);
    }
    tablas.set(nombre, t);
  }

  // Claves foraneas agregadas despues con ALTER TABLE (VENTA todavia no existia).
  for (const m of sql.matchAll(/ALTER TABLE (\w+)\s+ADD CONSTRAINT (\w+) FOREIGN KEY \(([^)]+)\) REFERENCES (\w+)\(([^)]+)\)/g)) {
    tablas.get(m[1]).fks.push({ nombre: m[2], columnas: lista(m[3]), tabla: m[4], ref: lista(m[5]), alBorrar: null });
  }

  // Indices unicos, filtrados o no.
  for (const m of sql.matchAll(/CREATE UNIQUE INDEX (\w+) ON (\w+)\(([^)]+)\)(?:\s+WHERE ([^;\n]+(?:\n\s+[^;\n]+)*))?/g)) {
    tablas.get(m[2]).unicos.push({ nombre: m[1], columnas: lista(m[3]), filtro: m[4]?.trim() ?? null });
  }

  // Consistencia: toda clave foranea apunta a una tabla y columnas que existen.
  for (const t of tablas.values()) {
    for (const fk of t.fks) {
      const destino = tablas.get(fk.tabla);
      if (!destino) throw new Error(`${fk.nombre} apunta a ${fk.tabla}, que no existe`);
      for (const c of [...fk.columnas]) {
        if (!t.columnas.some((x) => x.nombre === c)) throw new Error(`${fk.nombre}: ${t.nombre}.${c} no existe`);
      }
    }
  }
  return tablas;
}

/** Marcas de clave de una columna: PK, FK, UQ. */
export function marcas(t, columna) {
  const m = [];
  if (t.pk.includes(columna)) m.push('PK');
  if (t.fks.some((f) => f.columnas.includes(columna))) m.push('FK');
  // Un indice unico filtrado por "IS NOT NULL" hace la columna unica de
  // verdad. Uno filtrado por otra cosa no: UX_CAJA_ABIERTA_POR_TIENDA solo
  // impide dos cajas ABIERTAS en la misma tienda, y marcar tienda_id como
  // unica diria que cada tienda tiene una sola caja en toda su historia.
  if (t.unicos.some((u) => u.columnas.length === 1 && u.columnas[0] === columna &&
                           (!u.filtro || /^\w+ IS NOT NULL$/.test(u.filtro)))) m.push('UQ');
  return m;
}
