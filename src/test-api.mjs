// =============================================================================
// FERREPLAST -- Pruebas de la API
//
// Levanta la aplicacion real contra un PostgreSQL real (PGlite) y le manda
// peticiones HTTP mediante app.inject(), que recorre todo el ciclo de Fastify
// sin abrir un puerto.
//
// No hace falta servidor, ni Docker, ni conexion a internet.
//
// Uso:  node src/test-api.mjs
// =============================================================================

import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { crearClientePglite } from './db.mjs';
import { crearApp } from './servidor.mjs';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
const leerSql = (f) => readFileSync(join(raiz, 'db', f), 'utf8');

const TIENDA_FER = '22222222-0000-0000-0000-000000000001';
const TIENDA_PLA = '22222222-0000-0000-0000-000000000002';
const TORNILLO   = '55555555-0000-0000-0000-000000000001';
const MARTILLO   = '55555555-0000-0000-0000-000000000003';
const EMPLEADO   = '33333333-0000-0000-0000-000000000002';
const CAJA_FER   = '88888888-0000-0000-0000-000000000001';

let pasadas = 0, fallidas = 0;

function check(nombre, condicion, detalle = '') {
  if (condicion) { console.log(`  OK   ${nombre}`); pasadas++; }
  else { console.log(`  FALLA ${nombre}${detalle ? ' -> ' + detalle : ''}`); fallidas++; }
}

// -----------------------------------------------------------------------------
// Preparacion
// -----------------------------------------------------------------------------
const pglite = await PGlite.create({ extensions: { pg_trgm } });
await pglite.exec(leerSql('schema.sql'));
await pglite.exec(leerSql('seed.sql'));

const db = crearClientePglite(pglite);
const app = await crearApp({ db });

const pedir = (opciones) => app.inject(opciones);
const stockDe = async (tienda, producto) => {
  const { rows } = await db.query(
    'SELECT cantidad FROM stock WHERE tienda_id=$1 AND producto_id=$2',
    [tienda, producto]);
  return Number(rows[0].cantidad);
};

// -----------------------------------------------------------------------------
console.log('\n=== 1. Salud y catalogo ===');
{
  const r = await pedir({ method: 'GET', url: '/salud' });
  check('GET /salud responde 200', r.statusCode === 200, `codigo ${r.statusCode}`);
  check('informa la base conectada', r.json().base_de_datos === 'conectada');
}
{
  const r = await pedir({ method: 'GET', url: `/sync/catalogo/${TIENDA_FER}` });
  const cuerpo = r.json();
  check('GET /sync/catalogo responde 200', r.statusCode === 200);
  check('devuelve los 10 productos del catalogo', cuerpo.productos.length === 10,
        `recibidos: ${cuerpo.productos.length}`);
  const tornillo = cuerpo.productos.find((p) => p.id === TORNILLO);
  check('incluye el stock de la tienda pedida', Number(tornillo.stock) === 1450,
        `stock: ${tornillo?.stock}`);

  // El catalogo es del negocio, pero el stock es por tienda: el mismo producto
  // consultado desde la otra tienda debe venir en cero.
  const r2 = await pedir({ method: 'GET', url: `/sync/catalogo/${TIENDA_PLA}` });
  const tornilloPla = r2.json().productos.find((p) => p.id === TORNILLO);
  check('el stock del mismo producto es 0 en la otra tienda',
        Number(tornilloPla.stock) === 0, `stock: ${tornilloPla?.stock}`);
}
{
  const r = await pedir({ method: 'GET', url: `/sync/catalogo/${randomUUID()}` });
  check('tienda inexistente devuelve 404', r.statusCode === 404, `codigo ${r.statusCode}`);
}

// -----------------------------------------------------------------------------
console.log('\n=== 2. Envio de movimientos ===');
const idEntrada = randomUUID();
{
  const antes = await stockDe(TIENDA_FER, TORNILLO);
  const r = await pedir({
    method: 'POST', url: '/sync/push',
    payload: {
      movimientos: [{
        id: idEntrada, tienda_id: TIENDA_FER, producto_id: TORNILLO,
        usuario_id: EMPLEADO, tipo: 'entrada', cantidad: 500,
        costo_unitario: 0.40, motivo: 'compra a proveedor',
        ocurrido_en: new Date().toISOString(),
      }],
    },
  });
  const cuerpo = r.json();
  check('acepta una entrada de mercaderia', cuerpo.movimientos.aceptados === 1,
        JSON.stringify(cuerpo.movimientos));
  check('el stock sube 500', await stockDe(TIENDA_FER, TORNILLO) === antes + 500);
}

// -----------------------------------------------------------------------------
console.log('\n=== 3. Idempotencia: reenvio del mismo lote ===');
{
  const antes = await stockDe(TIENDA_FER, TORNILLO);
  const r = await pedir({
    method: 'POST', url: '/sync/push',
    payload: {
      movimientos: [{
        id: idEntrada, tienda_id: TIENDA_FER, producto_id: TORNILLO,
        usuario_id: EMPLEADO, tipo: 'entrada', cantidad: 500,
        costo_unitario: 0.40, motivo: 'compra a proveedor',
        ocurrido_en: new Date().toISOString(),
      }],
    },
  });
  const cuerpo = r.json();
  check('el reenvio se marca como duplicado', cuerpo.movimientos.duplicados === 1,
        JSON.stringify(cuerpo.movimientos));
  check('no se aplica dos veces', await stockDe(TIENDA_FER, TORNILLO) === antes);
}

// -----------------------------------------------------------------------------
console.log('\n=== 4. Envio de una venta completa ===');
const idVenta = randomUUID();
const ventaValida = {
  id: idVenta, tienda_id: TIENDA_FER, usuario_id: EMPLEADO, caja_id: CAJA_FER,
  numero: 'FER-2026-000100', subtotal: 175, descuento: 0, total: 175,
  metodo_pago: 'efectivo', ocurrido_en: new Date().toISOString(),
  lineas: [
    { producto_id: TORNILLO, cantidad: 100, precio_unitario: 1.00, costo_unitario: 0.40, subtotal: 100 },
    { producto_id: MARTILLO, cantidad: 1,   precio_unitario: 75.00, costo_unitario: 45.00, subtotal: 75 },
  ],
};
{
  const tornillosAntes = await stockDe(TIENDA_FER, TORNILLO);
  const martillosAntes = await stockDe(TIENDA_FER, MARTILLO);

  const r = await pedir({ method: 'POST', url: '/sync/push', payload: { ventas: [ventaValida] } });
  const cuerpo = r.json();
  check('acepta la venta', cuerpo.ventas.aceptados === 1, JSON.stringify(cuerpo.ventas));

  check('descuenta 100 tornillos', await stockDe(TIENDA_FER, TORNILLO) === tornillosAntes - 100);
  check('descuenta 1 martillo',    await stockDe(TIENDA_FER, MARTILLO) === martillosAntes - 1);

  const { rows: lineas } = await db.query(
    'SELECT COUNT(*)::int AS n FROM venta_lineas WHERE venta_id=$1', [idVenta]);
  check('guarda las 2 lineas', lineas[0].n === 2, `lineas: ${lineas[0].n}`);

  // Los movimientos NO los manda el cliente: los deriva el servidor de las lineas.
  const { rows: movs } = await db.query(
    `SELECT COUNT(*)::int AS n FROM movimientos_inventario
      WHERE venta_id=$1 AND tipo='venta'`, [idVenta]);
  check('deriva 2 movimientos de stock desde las lineas', movs[0].n === 2, `movimientos: ${movs[0].n}`);
}

// -----------------------------------------------------------------------------
console.log('\n=== 5. Idempotencia de la venta ===');
{
  const tornillosAntes = await stockDe(TIENDA_FER, TORNILLO);
  const r = await pedir({ method: 'POST', url: '/sync/push', payload: { ventas: [ventaValida] } });
  const cuerpo = r.json();
  check('el reenvio de la venta se marca duplicado', cuerpo.ventas.duplicados === 1,
        JSON.stringify(cuerpo.ventas));
  check('no descuenta el stock dos veces',
        await stockDe(TIENDA_FER, TORNILLO) === tornillosAntes);

  const { rows } = await db.query(
    'SELECT COUNT(*)::int AS n FROM venta_lineas WHERE venta_id=$1', [idVenta]);
  check('no duplica las lineas', rows[0].n === 2, `lineas: ${rows[0].n}`);
}

// -----------------------------------------------------------------------------
console.log('\n=== 6. Un elemento invalido no arrastra al resto del lote ===');
{
  const buena = { ...ventaValida, id: randomUUID(), numero: 'FER-2026-000101' };
  const mala  = {
    ...ventaValida, id: randomUUID(), numero: 'FER-2026-000102',
    total: 9999,  // no coincide con subtotal menos descuento
  };

  const r = await pedir({ method: 'POST', url: '/sync/push', payload: { ventas: [mala, buena] } });
  const cuerpo = r.json();

  check('la respuesta sigue siendo 200', r.statusCode === 200, `codigo ${r.statusCode}`);
  check('la venta valida entra igual', cuerpo.ventas.aceptados === 1,
        JSON.stringify(cuerpo.ventas));
  check('la invalida se rechaza', cuerpo.ventas.rechazados.length === 1);
  check('el rechazo indica que fue por validacion',
        cuerpo.ventas.rechazados[0]?.motivo === 'validacion',
        JSON.stringify(cuerpo.ventas.rechazados[0]));
}

// -----------------------------------------------------------------------------
console.log('\n=== 7. Atomicidad: una venta rota no deja restos ===');
{
  // La segunda linea apunta a un producto que no existe. La cabecera y la
  // primera linea ya se insertaron cuando falla: la transaccion tiene que
  // revertir TODO. Si quedara la cabecera, habria una venta sin stock
  // descontado y los reportes mentirian.
  const idRota = randomUUID();
  const tornillosAntes = await stockDe(TIENDA_FER, TORNILLO);

  const r = await pedir({
    method: 'POST', url: '/sync/push',
    payload: {
      ventas: [{
        ...ventaValida, id: idRota, numero: 'FER-2026-000103',
        lineas: [
          { producto_id: TORNILLO,     cantidad: 100, precio_unitario: 1.00, costo_unitario: 0.40, subtotal: 100 },
          { producto_id: randomUUID(), cantidad: 1,   precio_unitario: 75.00, costo_unitario: 45.00, subtotal: 75 },
        ],
      }],
    },
  });
  const cuerpo = r.json();
  check('se rechaza por error de base de datos',
        cuerpo.ventas.rechazados[0]?.motivo === 'base_de_datos',
        JSON.stringify(cuerpo.ventas.rechazados[0]));

  const { rows: cab } = await db.query(
    'SELECT COUNT(*)::int AS n FROM ventas WHERE id=$1', [idRota]);
  check('la cabecera de la venta NO queda guardada', cab[0].n === 0, `filas: ${cab[0].n}`);

  const { rows: lin } = await db.query(
    'SELECT COUNT(*)::int AS n FROM venta_lineas WHERE venta_id=$1', [idRota]);
  check('tampoco queda la primera linea', lin[0].n === 0, `filas: ${lin[0].n}`);

  check('el stock queda intacto', await stockDe(TIENDA_FER, TORNILLO) === tornillosAntes,
        `antes ${tornillosAntes}, ahora ${await stockDe(TIENDA_FER, TORNILLO)}`);
}

// -----------------------------------------------------------------------------
console.log('\n=== 8. Validaciones de movimientos ===');
{
  const r = await pedir({
    method: 'POST', url: '/sync/push',
    payload: {
      movimientos: [
        { id: randomUUID(), tienda_id: TIENDA_FER, producto_id: TORNILLO,
          tipo: 'venta', cantidad: 5, ocurrido_en: new Date().toISOString() },
        { id: randomUUID(), tienda_id: TIENDA_FER, producto_id: TORNILLO,
          tipo: 'entrada', cantidad: 0, ocurrido_en: new Date().toISOString() },
        { id: 'no-es-un-uuid', tienda_id: TIENDA_FER, producto_id: TORNILLO,
          tipo: 'entrada', cantidad: 5, ocurrido_en: new Date().toISOString() },
      ],
    },
  });
  const cuerpo = r.json();
  check('rechaza los 3 movimientos mal formados',
        cuerpo.movimientos.rechazados.length === 3 && cuerpo.movimientos.aceptados === 0,
        JSON.stringify(cuerpo.movimientos));
  check('explica que una venta no puede ser positiva',
        /positiva|negativa/.test(JSON.stringify(cuerpo.movimientos.rechazados[0].detalles)),
        JSON.stringify(cuerpo.movimientos.rechazados[0].detalles));
}

// -----------------------------------------------------------------------------
console.log('\n=== 9. Limite de tamanio del lote ===');
{
  const enorme = Array.from({ length: 501 }, () => ({
    id: randomUUID(), tienda_id: TIENDA_FER, producto_id: TORNILLO,
    tipo: 'entrada', cantidad: 1, ocurrido_en: new Date().toISOString(),
  }));
  const r = await pedir({ method: 'POST', url: '/sync/push', payload: { movimientos: enorme } });
  check('un lote de 501 elementos se rechaza con 413', r.statusCode === 413,
        `codigo ${r.statusCode}`);
}

// -----------------------------------------------------------------------------
console.log('\n=== 10. Bitacora de sincronizacion ===');
{
  const r = await pedir({
    method: 'POST', url: '/sync/push',
    payload: {
      dispositivo_id: '66666666-0000-0000-0000-000000000001',
      movimientos: [{
        id: randomUUID(), tienda_id: TIENDA_FER, producto_id: TORNILLO,
        tipo: 'entrada', cantidad: 10, ocurrido_en: new Date().toISOString(),
      }],
    },
  });
  check('la sincronizacion con dispositivo responde 200', r.statusCode === 200);

  const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM sync_log');
  check('queda registrada en sync_log', rows[0].n === 1, `filas: ${rows[0].n}`);

  const estado = await pedir({ method: 'GET', url: '/sync/estado' });
  const disp = estado.json().dispositivos.find(
    (d) => d.id === '66666666-0000-0000-0000-000000000001');
  check('el dispositivo registra su ultimo sync', disp?.ultimo_sync != null,
        JSON.stringify(disp));
}

// -----------------------------------------------------------------------------
console.log('\n=== 11. Reportes del panel ===');
{
  const r = await pedir({ method: 'GET', url: '/reportes/resumen' });
  const cuerpo = r.json();
  check('GET /reportes/resumen responde 200', r.statusCode === 200);
  check('trae las dos tiendas en el inventario valorizado',
        cuerpo.inventario_valorizado.length === 2,
        JSON.stringify(cuerpo.inventario_valorizado));
  check('consolida el total vendido del dia', typeof cuerpo.consolidado.total_vendido === 'number');
  console.log(`       vendido hoy: ${cuerpo.consolidado.total_vendido}`);
  console.log(`       ganancia:    ${cuerpo.consolidado.ganancia_bruta}`);
  console.log(`       alertas:     ${cuerpo.consolidado.cantidad_alertas}`);
}
{
  const r = await pedir({ method: 'GET', url: `/reportes/movimientos/${TORNILLO}` });
  const movs = r.json().movimientos;
  check('el historial del producto trae la auditoria completa', movs.length >= 4,
        `movimientos: ${movs.length}`);
  check('cada movimiento dice quien y cuando',
        movs.every((m) => 'usuario' in m && 'ocurrido_en' in m));
}

// -----------------------------------------------------------------------------
await app.close();
await db.cerrar();

console.log(`\n${'='.repeat(50)}`);
console.log(`Pruebas pasadas: ${pasadas}   fallidas: ${fallidas}`);
console.log('='.repeat(50));
process.exit(fallidas === 0 ? 0 : 1);
