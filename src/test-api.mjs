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
import { hashToken } from './auth/sesiones.mjs';

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

// -----------------------------------------------------------------------------
// Sesiones para las pruebas
//
// Desde que existe el guardia, TODA ruta pide token salvo las publicas. Se
// abren aca las tres sesiones que usan las pruebas y se arman tres formas de
// pedir, segun quien hace la peticion.
//
// Las credenciales son las de db/seed.sql.
// -----------------------------------------------------------------------------
async function entrarComoAdmin() {
  const r = await app.inject({
    method: 'POST', url: '/auth/login/admin',
    payload: { email: 'admin@ferreplast.test', password: 'ferreplast2026' },
  });
  if (r.statusCode !== 200) throw new Error(`no se pudo entrar como admin: ${r.body}`);
  return r.json().token;
}

async function entrarComoEmpleado(usuarioId, pin) {
  const r = await app.inject({
    method: 'POST', url: '/auth/login/pin',
    payload: { usuario_id: usuarioId, pin },
  });
  if (r.statusCode !== 200) throw new Error(`no se pudo entrar como empleado: ${r.body}`);
  return r.json().token;
}

const EMPLEADO_PLA = '33333333-0000-0000-0000-000000000003';

const tokenAdmin        = await entrarComoAdmin();
const tokenEmpleadoFer  = await entrarComoEmpleado(EMPLEADO, '1234');
const tokenEmpleadoPla  = await entrarComoEmpleado(EMPLEADO_PLA, '5678');

// Por omision las pruebas piden como admin, que puede operar sobre las dos
// tiendas. Las que verifican el alcance por tienda usan pedirComo().
const pedirComo = (token, opciones) => app.inject({
  ...opciones,
  headers: { ...opciones.headers, authorization: `Bearer ${token}` },
});
const pedir = (opciones) => pedirComo(tokenAdmin, opciones);
const pedirSinSesion = (opciones) => app.inject(opciones);

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
console.log('\n=== 12. Autenticacion ===');
{
  // Lo primero que hay que comprobar: que estar cerrado sea el estado por
  // omision. Si esto falla, todo lo demas da igual.
  const r = await pedirSinSesion({ method: 'GET', url: `/sync/catalogo/${TIENDA_FER}` });
  check('sin token una ruta protegida responde 401', r.statusCode === 401,
        `codigo ${r.statusCode}`);

  const basura = await pedirComo('token-inventado', { method: 'GET', url: '/auth/yo' });
  check('un token inventado responde 401', basura.statusCode === 401,
        `codigo ${basura.statusCode}`);

  const salud = await pedirSinSesion({ method: 'GET', url: '/salud' });
  check('/salud sigue siendo publica', salud.statusCode === 200, `codigo ${salud.statusCode}`);
}
{
  const r = await pedirSinSesion({ method: 'GET', url: `/auth/empleados/${TIENDA_FER}` });
  const cuerpo = r.json();
  check('la lista de empleados es publica', r.statusCode === 200, `codigo ${r.statusCode}`);
  check('trae al empleado de esa tienda', cuerpo.empleados.length === 1,
        JSON.stringify(cuerpo.empleados));
  // Lo que NO devuelve importa tanto como lo que devuelve.
  check('no filtra el hash del PIN ni el rol',
        Object.keys(cuerpo.empleados[0]).sort().join(',') === 'id,nombre',
        Object.keys(cuerpo.empleados[0]).join(','));
}
{
  const malPin = await pedirSinSesion({
    method: 'POST', url: '/auth/login/pin',
    payload: { usuario_id: EMPLEADO, pin: '9999' },
  });
  check('un PIN incorrecto responde 401', malPin.statusCode === 401, `codigo ${malPin.statusCode}`);

  const noExiste = await pedirSinSesion({
    method: 'POST', url: '/auth/login/admin',
    payload: { email: 'nadie@ferreplast.test', password: 'loquesea' },
  });
  const malaClave = await pedirSinSesion({
    method: 'POST', url: '/auth/login/admin',
    payload: { email: 'admin@ferreplast.test', password: 'equivocada' },
  });
  // Si los mensajes se diferenciaran, se podria averiguar que cuentas existen
  // sin acertar una sola clave.
  check('el email inexistente y la clave mala dan el MISMO error',
        noExiste.statusCode === malaClave.statusCode &&
        noExiste.json().error === malaClave.json().error,
        `${noExiste.json().error} / ${malaClave.json().error}`);
}
{
  const r = await pedir({ method: 'GET', url: '/auth/yo' });
  const cuerpo = r.json();
  check('GET /auth/yo identifica al usuario de la sesion',
        cuerpo.usuario.rol === 'admin' && cuerpo.usuario.nombre === 'Administrador',
        JSON.stringify(cuerpo.usuario));
}
{
  // El token en claro no puede estar en la base: si se filtra un volcado, no
  // debe servir para entrar como nadie.
  const { rows } = await db.query('SELECT token_hash FROM sesiones');
  check('la base guarda hashes de 64 caracteres, no los tokens',
        rows.length > 0 && rows.every((s) => /^[0-9a-f]{64}$/.test(s.token_hash)));
  check('el token entregado no aparece en la base',
        !rows.some((s) => s.token_hash === tokenAdmin));
}
{
  // Salir tiene que cortar de verdad, no solo borrar el token del cliente.
  const efimero = await entrarComoEmpleado(EMPLEADO, '1234');
  const antes = await pedirComo(efimero, { method: 'GET', url: '/auth/yo' });
  check('la sesion recien abierta funciona', antes.statusCode === 200);

  await pedirComo(efimero, { method: 'POST', url: '/auth/salir' });
  const despues = await pedirComo(efimero, { method: 'GET', url: '/auth/yo' });
  check('tras salir, el mismo token ya no sirve', despues.statusCode === 401,
        `codigo ${despues.statusCode}`);
}
{
  // Una sesion caducada no debe servir aunque nadie la haya revocado.
  //
  // Se envejece la fila a mano en lugar de esperar doce horas. Se ubica por su
  // hash, calculado con la misma funcion que usa el servidor, para tocar solo
  // esta sesion y no las otras que las pruebas tienen abiertas.
  //
  // Se mueven las DOS fechas, no solo la de expiracion: la restriccion
  // chk_sesion_vigencia exige que una sesion expire despues de haber nacido, y
  // tiene razon. Lo que se simula es que pasaron trece horas, no una fila
  // imposible que caduco antes de existir.
  const vencida = await entrarComoEmpleado(EMPLEADO, '1234');
  await db.query(
    `UPDATE sesiones
        SET created_at = NOW() - INTERVAL '13 hours',
            expira_en  = NOW() - INTERVAL '1 minute'
      WHERE token_hash = $1`,
    [hashToken(vencida)],
  );
  const r = await pedirComo(vencida, { method: 'GET', url: '/auth/yo' });
  check('una sesion vencida responde 401', r.statusCode === 401, `codigo ${r.statusCode}`);
}

// -----------------------------------------------------------------------------
console.log('\n=== 13. Alcance: cada uno en su tienda ===');
{
  const propia = await pedirComo(tokenEmpleadoPla,
    { method: 'GET', url: `/sync/catalogo/${TIENDA_PLA}` });
  check('el empleado ve el catalogo de SU tienda', propia.statusCode === 200,
        `codigo ${propia.statusCode}`);

  const ajena = await pedirComo(tokenEmpleadoPla,
    { method: 'GET', url: `/sync/catalogo/${TIENDA_FER}` });
  check('el empleado NO ve el catalogo de la otra tienda', ajena.statusCode === 403,
        `codigo ${ajena.statusCode}`);
}
{
  const reportes = await pedirComo(tokenEmpleadoFer, { method: 'GET', url: '/reportes/resumen' });
  check('el empleado no entra a los reportes del duenio', reportes.statusCode === 403,
        `codigo ${reportes.statusCode}`);

  const estado = await pedirComo(tokenEmpleadoFer, { method: 'GET', url: '/sync/estado' });
  check('el empleado no ve el estado de las tablets', estado.statusCode === 403,
        `codigo ${estado.statusCode}`);
}
{
  // Un lote con una operacion de cada tienda, enviado por el empleado de la
  // ferreteria. La suya entra; la otra se aparta, sin tumbar el lote.
  const mio   = randomUUID();
  const ajeno = randomUUID();
  const r = await pedirComo(tokenEmpleadoFer, {
    method: 'POST', url: '/sync/push',
    payload: {
      movimientos: [
        { id: mio,   tienda_id: TIENDA_FER, producto_id: TORNILLO,
          tipo: 'entrada', cantidad: 5, ocurrido_en: new Date().toISOString() },
        { id: ajeno, tienda_id: TIENDA_PLA, producto_id: TORNILLO,
          tipo: 'entrada', cantidad: 5, ocurrido_en: new Date().toISOString() },
      ],
    },
  });
  const cuerpo = r.json();
  check('el movimiento de su tienda entra', cuerpo.movimientos.aceptados === 1,
        JSON.stringify(cuerpo.movimientos));
  check('el de la otra tienda se rechaza por permiso',
        cuerpo.movimientos.rechazados[0]?.motivo === 'permiso',
        JSON.stringify(cuerpo.movimientos.rechazados[0]));

  const { rows } = await db.query(
    'SELECT COUNT(*)::int AS n FROM movimientos_inventario WHERE id = $1', [ajeno]);
  check('el rechazado no quedo guardado', rows[0].n === 0, `filas: ${rows[0].n}`);
}

// -----------------------------------------------------------------------------
console.log('\n=== 14. Limite de intentos fallidos ===');
{
  // Va al final a proposito: deja la cuenta de la plastiqueria bloqueada por
  // quince minutos, y cualquier prueba posterior fallaria por eso.
  //
  // Un PIN de 4 digitos son 10.000 combinaciones: sin este limite se agotan
  // solas en unas horas.
  for (let i = 0; i < 5; i++) {
    await pedirSinSesion({
      method: 'POST', url: '/auth/login/pin',
      payload: { usuario_id: EMPLEADO_PLA, pin: '0000' },
    });
  }

  const sexto = await pedirSinSesion({
    method: 'POST', url: '/auth/login/pin',
    payload: { usuario_id: EMPLEADO_PLA, pin: '0000' },
  });
  check('tras 5 fallos el siguiente intento da 429', sexto.statusCode === 429,
        `codigo ${sexto.statusCode}`);

  // Lo importante: el bloqueo vale INCLUSO con el PIN correcto. Si no, bastaria
  // con seguir probando hasta acertar.
  const conElCorrecto = await pedirSinSesion({
    method: 'POST', url: '/auth/login/pin',
    payload: { usuario_id: EMPLEADO_PLA, pin: '5678' },
  });
  check('el bloqueo rige aunque el PIN sea el correcto', conElCorrecto.statusCode === 429,
        `codigo ${conElCorrecto.statusCode}`);

  // El bloqueo es por usuario, no global: la ferreteria sigue vendiendo.
  const otroEmpleado = await pedirSinSesion({
    method: 'POST', url: '/auth/login/pin',
    payload: { usuario_id: EMPLEADO, pin: '1234' },
  });
  check('el bloqueo no alcanza a los demas empleados', otroEmpleado.statusCode === 200,
        `codigo ${otroEmpleado.statusCode}`);

  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS n FROM intentos_login WHERE NOT exitoso AND identificador = $1`,
    [EMPLEADO_PLA]);
  check('los intentos quedan registrados para auditoria', rows[0].n >= 5, `filas: ${rows[0].n}`);
}

// -----------------------------------------------------------------------------
await app.close();
await db.cerrar();

console.log(`\n${'='.repeat(50)}`);
console.log(`Pruebas pasadas: ${pasadas}   fallidas: ${fallidas}`);
console.log('='.repeat(50));
process.exit(fallidas === 0 ? 0 : 1);
