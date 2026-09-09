// =============================================================================
// FERREPLAST -- Pruebas del esquema de base de datos
//
// Ejecuta schema.sql y seed.sql sobre una instancia real de PostgreSQL
// (PGlite: Postgres compilado a WebAssembly, sin instalar ni servidor) y
// verifica que las reglas de negocio se cumplan de verdad.
//
// Uso:  node db/test-esquema.mjs
// =============================================================================

import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const aqui = dirname(fileURLToPath(import.meta.url));
const leer = (f) => readFileSync(join(aqui, f), 'utf8');

let pasadas = 0;
let fallidas = 0;

function check(nombre, condicion, detalle = '') {
  if (condicion) {
    console.log(`  OK   ${nombre}`);
    pasadas++;
  } else {
    console.log(`  FALLA ${nombre}${detalle ? ' -> ' + detalle : ''}`);
    fallidas++;
  }
}

// Verifica que una operacion sea RECHAZADA por la base de datos.
async function debeFallar(db, nombre, sql) {
  try {
    await db.exec(sql);
    check(nombre, false, 'la base acepto una operacion que debia rechazar');
  } catch (e) {
    check(nombre, true);
  }
}

const db = await PGlite.create({ extensions: { pg_trgm } });

console.log('\n=== 1. Carga del esquema y los datos ===');
await db.exec(leer('schema.sql'));
check('schema.sql se ejecuta', true);
await db.exec(leer('seed.sql'));
check('seed.sql se ejecuta', true);

// -----------------------------------------------------------------------------
console.log('\n=== 2. El trigger de stock calcula bien ===');
// Ferreteria: entraron 1500 tornillos, se vendieron 50 -> deben quedar 1450.
{
  const { rows } = await db.query(`
    SELECT cantidad FROM stock
    WHERE tienda_id = '22222222-0000-0000-0000-000000000001'
      AND producto_id = '55555555-0000-0000-0000-000000000001'`);
  check('1500 entradas - 50 vendidos = 1450', Number(rows[0].cantidad) === 1450,
        `obtenido: ${rows[0]?.cantidad}`);
}
// El stock cacheado debe coincidir con la suma de movimientos, para todo producto.
{
  const { rows } = await db.query(`
    SELECT COUNT(*)::int AS desalineados
    FROM stock s
    LEFT JOIN (
      SELECT tienda_id, producto_id, SUM(cantidad) AS total
      FROM movimientos_inventario GROUP BY 1,2
    ) m ON m.tienda_id = s.tienda_id AND m.producto_id = s.producto_id
    WHERE s.cantidad <> COALESCE(m.total, 0)`);
  check('cache de stock == suma de movimientos', rows[0].desalineados === 0,
        `${rows[0].desalineados} filas desalineadas`);
}

// -----------------------------------------------------------------------------
console.log('\n=== 3. Restricciones de integridad ===');
await debeFallar(db, 'rechaza una venta con cantidad POSITIVA', `
  INSERT INTO movimientos_inventario (id, tienda_id, producto_id, tipo, cantidad, ocurrido_en)
  VALUES ('7fffffff-0000-0000-0000-00000000000a','22222222-0000-0000-0000-000000000001',
          '55555555-0000-0000-0000-000000000001','venta', 10, NOW())`);

await debeFallar(db, 'rechaza un movimiento de cantidad CERO', `
  INSERT INTO movimientos_inventario (id, tienda_id, producto_id, tipo, cantidad, ocurrido_en)
  VALUES ('7fffffff-0000-0000-0000-00000000000b','22222222-0000-0000-0000-000000000001',
          '55555555-0000-0000-0000-000000000001','ajuste', 0, NOW())`);

await debeFallar(db, 'rechaza una venta cuyo total no cuadra', `
  INSERT INTO ventas (id, tienda_id, numero, subtotal, descuento, total, ocurrido_en)
  VALUES ('9fffffff-0000-0000-0000-00000000000a','22222222-0000-0000-0000-000000000001',
          'FER-2026-009999', 100, 10, 999, NOW())`);

await debeFallar(db, 'rechaza un admin sin contrasenia', `
  INSERT INTO usuarios (negocio_id, nombre, email, rol)
  VALUES ('11111111-0000-0000-0000-000000000001','Falso','falso@test.com','admin')`);

await debeFallar(db, 'rechaza un producto con codigo duplicado', `
  INSERT INTO productos (negocio_id, codigo, nombre, precio_venta)
  VALUES ('11111111-0000-0000-0000-000000000001','FER-TOR-038','Duplicado', 1)`);

await debeFallar(db, 'rechaza dos cajas abiertas en la misma tienda', `
  INSERT INTO cajas (tienda_id, monto_inicial, estado)
  VALUES ('22222222-0000-0000-0000-000000000001', 100, 'abierta')`);

// -----------------------------------------------------------------------------
console.log('\n=== 4. El historial es inmutable (append-only) ===');
await debeFallar(db, 'no se puede MODIFICAR un movimiento', `
  UPDATE movimientos_inventario SET cantidad = 9999
  WHERE id = '77777777-0000-0000-0000-000000000001'`);

await debeFallar(db, 'no se puede BORRAR un movimiento', `
  DELETE FROM movimientos_inventario
  WHERE id = '77777777-0000-0000-0000-000000000001'`);

// -----------------------------------------------------------------------------
console.log('\n=== 5. Sincronizacion idempotente ===');
// Simula que la tablet reenvia el mismo movimiento porque se corto la conexion
// antes de recibir la confirmacion. No debe descontarse el stock dos veces.
{
  const antes = await db.query(`
    SELECT cantidad FROM stock
    WHERE tienda_id='22222222-0000-0000-0000-000000000001'
      AND producto_id='55555555-0000-0000-0000-000000000001'`);

  await db.exec(`
    INSERT INTO movimientos_inventario (id, tienda_id, producto_id, tipo, cantidad, ocurrido_en)
    VALUES ('77777777-0000-0000-0000-000000000011','22222222-0000-0000-0000-000000000001',
            '55555555-0000-0000-0000-000000000001','venta', -50, NOW())
    ON CONFLICT (id) DO NOTHING`);

  const despues = await db.query(`
    SELECT cantidad FROM stock
    WHERE tienda_id='22222222-0000-0000-0000-000000000001'
      AND producto_id='55555555-0000-0000-0000-000000000001'`);

  check('reenviar el mismo movimiento no descuenta dos veces',
        Number(antes.rows[0].cantidad) === Number(despues.rows[0].cantidad),
        `antes ${antes.rows[0].cantidad}, despues ${despues.rows[0].cantidad}`);
}

// Dos movimientos distintos que llegan juntos SI se acumulan.
{
  await db.exec(`
    INSERT INTO movimientos_inventario (id, tienda_id, producto_id, tipo, cantidad, ocurrido_en)
    VALUES ('7abcdef0-0000-0000-0000-000000000001','22222222-0000-0000-0000-000000000001',
            '55555555-0000-0000-0000-000000000001','venta', -3, NOW()),
           ('7abcdef0-0000-0000-0000-000000000002','22222222-0000-0000-0000-000000000001',
            '55555555-0000-0000-0000-000000000001','venta', -5, NOW())
    ON CONFLICT (id) DO NOTHING`);

  const { rows } = await db.query(`
    SELECT cantidad FROM stock
    WHERE tienda_id='22222222-0000-0000-0000-000000000001'
      AND producto_id='55555555-0000-0000-0000-000000000001'`);
  check('dos ventas offline distintas se suman (1450 - 8 = 1442)',
        Number(rows[0].cantidad) === 1442, `obtenido: ${rows[0].cantidad}`);
}

// -----------------------------------------------------------------------------
console.log('\n=== 6. Reconciliacion del cache ===');
{
  // Se corrompe el cache a proposito, simulando un bug o una carga manual.
  await db.exec(`
    UPDATE stock SET cantidad = 1
    WHERE tienda_id='22222222-0000-0000-0000-000000000001'
      AND producto_id='55555555-0000-0000-0000-000000000001'`);

  const { rows } = await db.query(`SELECT * FROM fn_recalcular_stock()`);
  check('fn_recalcular_stock detecta la desalineacion', rows.length === 1,
        `filas reportadas: ${rows.length}`);
  check('informa el valor previo (1) y el correcto (1442)',
        rows.length === 1 && Number(rows[0].cantidad_previa) === 1
                          && Number(rows[0].cantidad_real) === 1442,
        rows.length ? `previa=${rows[0].cantidad_previa} real=${rows[0].cantidad_real}` : '');

  const post = await db.query(`
    SELECT cantidad FROM stock
    WHERE tienda_id='22222222-0000-0000-0000-000000000001'
      AND producto_id='55555555-0000-0000-0000-000000000001'`);
  check('el stock queda corregido', Number(post.rows[0].cantidad) === 1442,
        `obtenido: ${post.rows[0].cantidad}`);
}

// -----------------------------------------------------------------------------
console.log('\n=== 7. Vistas del panel ===');
{
  const { rows } = await db.query(`
    SELECT tienda, SUM(valor_costo) AS costo, SUM(valor_venta) AS venta
    FROM v_inventario_valorizado GROUP BY tienda ORDER BY tienda`);
  check('v_inventario_valorizado devuelve las dos tiendas', rows.length === 2);
  rows.forEach(r => console.log(`       ${r.tienda}: costo ${r.costo} / venta ${r.venta}`));
}
{
  // Una venta con DOS lineas. Si la vista tuviera el error de fan-out, el
  // total se contaria dos veces y la ganancia saldria inflada.
  const { rows } = await db.query(`SELECT * FROM v_ventas_diarias`);
  check('v_ventas_diarias devuelve una fila por tienda y dia', rows.length === 1);
  if (rows.length) {
    // Venta de 125. Costo: 50 tornillos x 0.40 = 20, mas 1 martillo x 45 = 45 -> 65.
    check('total vendido = 125 (no 250: sin fan-out)',
          Number(rows[0].total_vendido) === 125, `obtenido: ${rows[0].total_vendido}`);
    check('costo de mercaderia = 65', Number(rows[0].costo_mercaderia) === 65,
          `obtenido: ${rows[0].costo_mercaderia}`);
    check('ganancia bruta = 125 - 65 = 60', Number(rows[0].ganancia_bruta) === 60,
          `obtenido: ${rows[0].ganancia_bruta}`);
  }
}
{
  // Segunda venta, de una sola linea, el mismo dia y en la misma tienda:
  // confirma que la agregacion sigue bien al acumular varias ventas.
  //
  // La fecha se toma de la venta del seed en lugar de usar NOW(). Con NOW() la
  // prueba fallaba entre medianoche y las dos de la madrugada: el seed carga su
  // venta con NOW() - 2 horas, que a esa hora cae en el dia anterior, y como
  // v_ventas_diarias agrupa por fecha, las dos ventas se separaban en dos filas.
  await db.exec(`
    INSERT INTO ventas (id, tienda_id, usuario_id, numero, subtotal, descuento, total, ocurrido_en)
    VALUES ('99999999-0000-0000-0000-000000000002','22222222-0000-0000-0000-000000000001',
            '33333333-0000-0000-0000-000000000002','FER-2026-000002', 26, 0, 26,
            (SELECT ocurrido_en FROM ventas WHERE id='99999999-0000-0000-0000-000000000001'));
    INSERT INTO venta_lineas (venta_id, producto_id, cantidad, precio_unitario, costo_unitario, subtotal)
    VALUES ('99999999-0000-0000-0000-000000000002','55555555-0000-0000-0000-000000000002',
            1, 26.00, 18.00, 26.00);`);

  const { rows } = await db.query(`
    SELECT * FROM v_ventas_diarias
    WHERE tienda_id = '22222222-0000-0000-0000-000000000001'`);
  // 125 + 26 = 151 vendido; costo 65 + 18 = 83; ganancia 68.
  check('dos ventas: total 151, costo 83, ganancia 68',
        rows.length === 1 && Number(rows[0].total_vendido) === 151
                          && Number(rows[0].costo_mercaderia) === 83
                          && Number(rows[0].ganancia_bruta) === 68,
        rows.length ? `vendido=${rows[0].total_vendido} costo=${rows[0].costo_mercaderia} ganancia=${rows[0].ganancia_bruta}` : '');
  check('ticket promedio = (125+26)/2 = 75.50',
        rows.length === 1 && Number(rows[0].ticket_promedio) === 75.5,
        rows.length ? `obtenido: ${rows[0].ticket_promedio}` : '');
}
{
  // Sin nada bajo el minimo la vista devuelve vacio y no probaria nada, asi
  // que se provoca una alerta real: se venden baldes hasta bajar del umbral.
  const vacio = await db.query(`SELECT * FROM v_alertas_stock`);
  check('sin faltantes, v_alertas_stock viene vacia', vacio.rows.length === 0,
        `filas: ${vacio.rows.length}`);

  // Baldes: hay 80, el minimo es 15. Se venden 70 -> quedan 10, bajo el minimo.
  await db.exec(`
    INSERT INTO movimientos_inventario (id, tienda_id, producto_id, tipo, cantidad, ocurrido_en)
    VALUES ('7bbbbbbb-0000-0000-0000-000000000001','22222222-0000-0000-0000-000000000002',
            '55555555-0000-0000-0000-000000000006','venta', -70, NOW())`);

  const { rows } = await db.query(`SELECT * FROM v_alertas_stock`);
  check('al bajar del minimo aparece la alerta', rows.length === 1,
        `filas: ${rows.length}`);
  check('la alerta es del balde, con 10 unidades',
        rows.length === 1 && rows[0].codigo === 'PLA-BAL-020'
                          && Number(rows[0].cantidad) === 10,
        rows.length ? `${rows[0].codigo} -> ${rows[0].cantidad}` : '');
  rows.forEach(r => console.log(`       ${r.tienda}: ${r.producto} -> ${r.cantidad} (min ${r.cantidad_minima})`));
}

// -----------------------------------------------------------------------------
console.log('\n=== 8. Busqueda de productos en el mostrador ===');
{
  const { rows } = await db.query(
    `SELECT nombre FROM productos WHERE nombre ILIKE '%torn%' AND activo`);
  check('buscar "torn" encuentra el tornillo', rows.length === 1, JSON.stringify(rows));
}

// -----------------------------------------------------------------------------
console.log(`\n${'='.repeat(50)}`);
console.log(`Pruebas pasadas: ${pasadas}   fallidas: ${fallidas}`);
console.log('='.repeat(50));
process.exit(fallidas === 0 ? 0 : 1);
