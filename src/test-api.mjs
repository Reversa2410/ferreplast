// =============================================================================
// FERREPLAST -- Pruebas de la API
//
// Levanta la aplicacion real contra un SQL Server real y le manda peticiones
// mediante app.inject(), que recorre todo el ciclo de Fastify -- hooks de
// autenticacion incluidos -- sin abrir un puerto.
//
// Uso:  npm run test:api
//
// SOBRE LA BASE QUE USA
// Crea una base DESCARTABLE (FerreplastPruebaApi), le aplica db/schema.sql y
// db/seed.sql, corre las pruebas y la borra al terminar.
//
// NUNCA toca Ferreplast ni FerreplastDB. No es una precaucion teorica:
// schema.sql empieza con una tanda de DROP TABLE, asi que apuntar las pruebas a
// la base de trabajo borraria los datos reales. El nombre de la base se
// reemplaza en una copia de los scripts, en el directorio temporal; los
// archivos del repositorio no se modifican.
// =============================================================================

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import { crearClienteSqlServer } from './db.mjs';
import { crearApp } from './servidor.mjs';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');

const BASE_REAL = 'FerreplastDB';
const BASE_PRUEBA = 'FerreplastPruebaApi';
const SERVIDOR = process.env.DB_SERVIDOR || 'localhost';

// Datos que crea db/seed.sql. Si el seed cambia, estas constantes son lo
// primero que hay que revisar.
const TIENDA_FER = 1;
const TIENDA_PLA = 2;
const ADMIN_EMAIL = 'admin@ferreplast.com';
const ADMIN_CLAVE = 'ferreplast2026';
const JUAN = 2;            // empleado de LAS DOS tiendas
const JUAN_PIN = '1234';
const MARIA = 3;           // empleada solo de la plastiqueria
const MARIA_PIN = '5678';
const CLIENTE_CONSTRUCTORA = 2;
const DISPOSITIVO_FER = 1;

let pasadas = 0;
let fallidas = 0;

function check(nombre, condicion, detalle = '') {
  if (condicion) {
    console.log(`  OK    ${nombre}`);
    pasadas++;
  } else {
    console.log(`  FALLA ${nombre}${detalle ? ' -> ' + detalle : ''}`);
    fallidas++;
  }
}

// -----------------------------------------------------------------------------
// Preparacion de la base descartable
// -----------------------------------------------------------------------------

function sqlcmd(argumentos) {
  return execFileSync('sqlcmd', ['-S', SERVIDOR, '-E', '-C', '-f', '65001', '-b', ...argumentos], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

const temporal = mkdtempSync(join(tmpdir(), 'ferreplast-test-'));

/**
 * Copia un script del repositorio cambiandole el nombre de la base.
 *
 * Los scripts traen "FerreplastDB" fijo (IF DB_ID / USE). Reemplazarlo en una
 * copia es lo que garantiza que las pruebas no puedan alcanzar la base real,
 * sin tener que modificar los scripts para que acepten un parametro.
 */
function scriptApuntadoALaPrueba(nombre) {
  const original = readFileSync(join(raiz, 'db', nombre), 'utf8');
  const destino = join(temporal, nombre);
  writeFileSync(destino, original.replaceAll(BASE_REAL, BASE_PRUEBA), 'utf8');
  return destino;
}

function borrarBaseDePrueba() {
  try {
    // SINGLE_USER WITH ROLLBACK IMMEDIATE corta cualquier conexion que haya
    // quedado colgada: sin eso, el DROP falla porque la base esta en uso y la
    // proxima corrida arranca sobre datos de la anterior.
    sqlcmd(['-d', 'master', '-Q',
      `IF DB_ID('${BASE_PRUEBA}') IS NOT NULL BEGIN
         ALTER DATABASE ${BASE_PRUEBA} SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
         DROP DATABASE ${BASE_PRUEBA};
       END`]);
  } catch (e) {
    console.warn(`  (aviso) no se pudo borrar ${BASE_PRUEBA}: ${e.message.split('\n')[0]}`);
  }
}

console.log(`\nPreparando ${BASE_PRUEBA} en ${SERVIDOR}...`);
borrarBaseDePrueba();   // por si una corrida anterior se corto a la mitad
sqlcmd(['-i', scriptApuntadoALaPrueba('schema.sql')]);
sqlcmd(['-i', scriptApuntadoALaPrueba('seed.sql')]);

const db = await crearClienteSqlServer({ base: BASE_PRUEBA });

// Con DEBUG_API=1 la aplicacion registra los errores que la API esconde al
// cliente a proposito. Hace falta para diagnosticar: cuando /sync/push rechaza
// un elemento por "base_de_datos", el motivo real solo existe en este registro.
const app = await crearApp({
  db,
  logger: process.env.DEBUG_API === '1' ? { level: 'error' } : false,
});

// Confirmacion de que no se apunto a la base equivocada. Es barato y cubre el
// unico error de esta prueba que seria grave.
const { rows: dondeEstamos } = await db.query('SELECT DB_NAME() AS base');
if (dondeEstamos[0].base !== BASE_PRUEBA) {
  throw new Error(`las pruebas apuntan a ${dondeEstamos[0].base}, no a ${BASE_PRUEBA}`);
}

// -----------------------------------------------------------------------------
// Ayudas para pedir
// -----------------------------------------------------------------------------

const pedir = (metodo, url, token, payload) =>
  app.inject({
    method: metodo,
    url,
    ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
    ...(payload !== undefined ? { payload } : {}),
  });

async function entrarComoAdmin() {
  const r = await pedir('POST', '/auth/login/admin', null,
    { email: ADMIN_EMAIL, password: ADMIN_CLAVE });
  if (r.statusCode !== 200) throw new Error(`no se pudo entrar como admin: ${r.body}`);
  return r.json().token;
}

async function entrarComoEmpleado(usuarioId, pin, tiendaId) {
  const r = await pedir('POST', '/auth/login/pin', null,
    { usuario_id: usuarioId, tienda_id: tiendaId, pin });
  if (r.statusCode !== 200) throw new Error(`no se pudo entrar como empleado: ${r.body}`);
  return r.json().token;
}

// Un producto real del catalogo, para las pruebas que mueven stock. Se consulta
// en lugar de fijarlo: los id del seed son IDENTITY y cambian si se agregan
// filas antes.
const { rows: paraMover } = await db.query(
  `SELECT TOP 1 s.producto_id, s.cantidad, p.precio_venta, p.precio_costo
     FROM Stock s JOIN PRODUCTO p ON p.id = s.producto_id
    WHERE s.tienda_id = @tienda AND s.cantidad > 50
    ORDER BY s.producto_id`,
  { tienda: TIENDA_FER },
);
const PRODUCTO = paraMover[0].producto_id;
const PRECIO = Number(paraMover[0].precio_venta);
const COSTO = Number(paraMover[0].precio_costo);

const stockDe = async (productoId, tiendaId) => {
  const { rows } = await db.query(
    'SELECT cantidad FROM Stock WHERE producto_id = @p AND tienda_id = @t',
    { p: productoId, t: tiendaId },
  );
  return Number(rows[0]?.cantidad ?? 0);
};

const ahora = () => new Date().toISOString();

console.log('\n=============================================================');
console.log('PRUEBAS DE LA API');
console.log('=============================================================');

// -----------------------------------------------------------------------------
console.log('\n1. Salud y rutas publicas');
// -----------------------------------------------------------------------------
{
  const salud = await pedir('GET', '/salud');
  check('GET /salud responde sin token', salud.statusCode === 200, `codigo ${salud.statusCode}`);
  check('GET /salud dice que la base esta conectada',
    salud.json().base_de_datos === 'conectada');

  const tiendas = await pedir('GET', '/tiendas');
  check('GET /tiendas responde sin token', tiendas.statusCode === 200);
  check('GET /tiendas devuelve las dos tiendas',
    tiendas.json().tiendas.length === 2, JSON.stringify(tiendas.json().tiendas));
}

// -----------------------------------------------------------------------------
console.log('\n2. Lista de empleados por tienda');
// -----------------------------------------------------------------------------
{
  const fer = await pedir('GET', `/auth/empleados/${TIENDA_FER}`);
  const nombresFer = fer.json().empleados.map((e) => e.nombre);
  check('la ferreteria lista solo a Juan',
    nombresFer.length === 1 && nombresFer[0].startsWith('Juan'), JSON.stringify(nombresFer));

  const pla = await pedir('GET', `/auth/empleados/${TIENDA_PLA}`);
  const nombresPla = pla.json().empleados.map((e) => e.nombre).sort();
  check('la plastiqueria lista a Juan y a Maria (empleado compartido)',
    nombresPla.length === 2, JSON.stringify(nombresPla));

  check('la lista no expone al administrador',
    !nombresFer.concat(nombresPla).some((n) => n.includes('Admin')));

  check('la lista no expone el hash del PIN',
    Object.keys(fer.json().empleados[0]).every((k) => !k.includes('hash')),
    JSON.stringify(Object.keys(fer.json().empleados[0])));

  const inexistente = await pedir('GET', '/auth/empleados/9999');
  check('una tienda inexistente da 404', inexistente.statusCode === 404);

  const basura = await pedir('GET', '/auth/empleados/abc');
  check('un identificador que no es numero da 400', basura.statusCode === 400);
}

// -----------------------------------------------------------------------------
console.log('\n3. Ingreso del administrador');
// -----------------------------------------------------------------------------
let tokenAdmin;
{
  const ok = await pedir('POST', '/auth/login/admin', null,
    { email: ADMIN_EMAIL, password: ADMIN_CLAVE });
  check('entra con las credenciales correctas', ok.statusCode === 200, ok.body);
  check('la respuesta trae token', typeof ok.json().token === 'string');
  check('el rol es administrador', ok.json().usuario.rol === 'administrador');
  check('el administrador no queda atado a una tienda',
    ok.json().usuario.tienda_id === null);
  check('la respuesta no filtra el hash de la contrasenia',
    !JSON.stringify(ok.json()).includes('scrypt'));

  const mayusculas = await pedir('POST', '/auth/login/admin', null,
    { email: ADMIN_EMAIL.toUpperCase(), password: ADMIN_CLAVE });
  check('el email no distingue mayusculas', mayusculas.statusCode === 200);

  const malaClave = await pedir('POST', '/auth/login/admin', null,
    { email: ADMIN_EMAIL, password: 'equivocada' });
  check('rechaza la contrasenia incorrecta', malaClave.statusCode === 401);
  check('no dice si el problema fue el email o la clave',
    malaClave.json().error === 'credenciales incorrectas', malaClave.body);

  const inexistente = await pedir('POST', '/auth/login/admin', null,
    { email: 'nadie@ferreplast.com', password: ADMIN_CLAVE });
  check('un email inexistente da el mismo mensaje',
    inexistente.statusCode === 401 && inexistente.json().error === 'credenciales incorrectas');

  const invalido = await pedir('POST', '/auth/login/admin', null, { email: 'no-es-email' });
  check('un cuerpo mal formado da 400', invalido.statusCode === 400);

  tokenAdmin = await entrarComoAdmin();
}

// -----------------------------------------------------------------------------
console.log('\n4. Ingreso del empleado y eleccion de tienda');
// -----------------------------------------------------------------------------
let tokenJuanFer;
let tokenJuanPla;
let tokenMaria;
{
  const enFer = await pedir('POST', '/auth/login/pin', null,
    { usuario_id: JUAN, tienda_id: TIENDA_FER, pin: JUAN_PIN });
  check('Juan entra eligiendo la ferreteria', enFer.statusCode === 200, enFer.body);
  check('la sesion queda con la tienda elegida',
    enFer.json().usuario.tienda_id === TIENDA_FER, JSON.stringify(enFer.json().usuario));

  const enPla = await pedir('POST', '/auth/login/pin', null,
    { usuario_id: JUAN, tienda_id: TIENDA_PLA, pin: JUAN_PIN });
  check('el MISMO Juan entra eligiendo la plastiqueria', enPla.statusCode === 200, enPla.body);
  check('y esa sesion queda con la otra tienda',
    enPla.json().usuario.tienda_id === TIENDA_PLA);

  const mariaEnFer = await pedir('POST', '/auth/login/pin', null,
    { usuario_id: MARIA, tienda_id: TIENDA_FER, pin: MARIA_PIN });
  check('Maria no puede elegir una tienda a la que no esta asignada',
    mariaEnFer.statusCode === 403, `codigo ${mariaEnFer.statusCode}: ${mariaEnFer.body}`);

  const pinMalo = await pedir('POST', '/auth/login/pin', null,
    { usuario_id: JUAN, tienda_id: TIENDA_FER, pin: '9999' });
  check('rechaza el PIN incorrecto', pinMalo.statusCode === 401);

  const sinTienda = await pedir('POST', '/auth/login/pin', null,
    { usuario_id: JUAN, pin: JUAN_PIN });
  check('el ingreso sin tienda da 400', sinTienda.statusCode === 400, sinTienda.body);

  const pinCorto = await pedir('POST', '/auth/login/pin', null,
    { usuario_id: JUAN, tienda_id: TIENDA_FER, pin: '12' });
  check('un PIN de menos de 4 digitos da 400', pinCorto.statusCode === 400);

  tokenJuanFer = await entrarComoEmpleado(JUAN, JUAN_PIN, TIENDA_FER);
  tokenJuanPla = await entrarComoEmpleado(JUAN, JUAN_PIN, TIENDA_PLA);
  tokenMaria = await entrarComoEmpleado(MARIA, MARIA_PIN, TIENDA_PLA);
}

// -----------------------------------------------------------------------------
console.log('\n5. El guardia cierra todo lo que no es publico');
// -----------------------------------------------------------------------------
{
  const sinToken = await pedir('GET', '/auth/yo');
  check('sin cabecera Authorization da 401', sinToken.statusCode === 401);

  const tokenFalso = await pedir('GET', '/auth/yo', 'esto-no-es-un-token');
  check('con un token inventado da 401', tokenFalso.statusCode === 401);
  check('no distingue token invalido de caducado',
    tokenFalso.json().error === 'sesion invalida o expirada', tokenFalso.body);

  const malEsquema = await app.inject({
    method: 'GET', url: '/auth/yo', headers: { authorization: tokenJuanFer },
  });
  check('un token sin el prefijo Bearer da 401', malEsquema.statusCode === 401);

  const yo = await pedir('GET', '/auth/yo', tokenJuanFer);
  check('GET /auth/yo responde con la sesion', yo.statusCode === 200);
  check('GET /auth/yo informa la tienda de la sesion, no la del usuario',
    yo.json().usuario.tienda_id === TIENDA_FER, JSON.stringify(yo.json().usuario));
}

// -----------------------------------------------------------------------------
console.log('\n6. Alcance por tienda');
// -----------------------------------------------------------------------------
{
  const propia = await pedir('GET', `/sync/catalogo/${TIENDA_FER}`, tokenJuanFer);
  check('el empleado ve el catalogo de su tienda', propia.statusCode === 200, propia.body);

  const ajena = await pedir('GET', `/sync/catalogo/${TIENDA_PLA}`, tokenJuanFer);
  check('el empleado NO ve el catalogo de la otra tienda, aunque trabaje ahi',
    ajena.statusCode === 403, `codigo ${ajena.statusCode}`);

  const conLaOtraSesion = await pedir('GET', `/sync/catalogo/${TIENDA_PLA}`, tokenJuanPla);
  check('con la sesion de la otra tienda, el mismo Juan si lo ve',
    conLaOtraSesion.statusCode === 200, conLaOtraSesion.body);

  const admin1 = await pedir('GET', `/sync/catalogo/${TIENDA_FER}`, tokenAdmin);
  const admin2 = await pedir('GET', `/sync/catalogo/${TIENDA_PLA}`, tokenAdmin);
  check('el administrador ve las dos',
    admin1.statusCode === 200 && admin2.statusCode === 200);

  const catalogo = propia.json();
  check('el catalogo trae productos', catalogo.productos.length > 0);
  check('el catalogo trae las categorias para agrupar', catalogo.categorias.length > 0);
  check('cada producto trae su stock en esa tienda',
    catalogo.productos.every((p) => p.stock !== undefined));
  check('el catalogo no expone el margen de otra tienda',
    catalogo.tienda.id === TIENDA_FER);
}

// -----------------------------------------------------------------------------
console.log('\n7. Reportes: solo para el administrador');
// -----------------------------------------------------------------------------
{
  for (const ruta of ['/reportes/resumen', '/reportes/ventas', '/reportes/inventario',
    '/reportes/cuentas-por-cobrar', '/reportes/cuadre-caja', '/sync/estado']) {
    const comoEmpleado = await pedir('GET', ruta, tokenJuanFer);
    check(`${ruta} rechaza al empleado con 403`, comoEmpleado.statusCode === 403,
      `codigo ${comoEmpleado.statusCode}`);
  }

  const resumen = await pedir('GET', '/reportes/resumen', tokenAdmin);
  check('/reportes/resumen responde al administrador', resumen.statusCode === 200, resumen.body);
  check('el resumen consolida las dos tiendas',
    Array.isArray(resumen.json().por_tienda));
  check('el resumen informa el inventario valorizado',
    resumen.json().inventario_valorizado.length === 2,
    JSON.stringify(resumen.json().inventario_valorizado));
  check('el resumen informa cuanto hay por cobrar',
    typeof resumen.json().consolidado.por_cobrar === 'number');

  const inventario = await pedir('GET', '/reportes/inventario', tokenAdmin);
  check('/reportes/inventario devuelve filas', inventario.json().inventario.length > 0);

  const porTienda = await pedir('GET', `/reportes/inventario?tienda_id=${TIENDA_FER}`, tokenAdmin);
  check('/reportes/inventario filtra por tienda',
    porTienda.json().inventario.every((f) => f.tienda_id === TIENDA_FER));

  const movimientos = await pedir('GET', `/reportes/movimientos/${PRODUCTO}`, tokenAdmin);
  check('/reportes/movimientos devuelve el historial del producto',
    movimientos.statusCode === 200 && movimientos.json().movimientos.length > 0,
    movimientos.body.slice(0, 200));

  const estado = await pedir('GET', '/sync/estado', tokenAdmin);
  check('/sync/estado lista los dispositivos', estado.json().dispositivos.length === 3,
    JSON.stringify(estado.json().dispositivos.length));
  check('/sync/estado calcula los minutos sin sincronizar',
    estado.json().dispositivos.every((d) => typeof d.minutos_sin_sincronizar === 'number'));
}

// -----------------------------------------------------------------------------
console.log('\n8. Sincronizacion: movimientos de inventario');
// -----------------------------------------------------------------------------
{
  const antes = await stockDe(PRODUCTO, TIENDA_FER);
  const uuid = randomUUID();
  const movimiento = {
    uuid_externo: uuid,
    tienda_id: TIENDA_FER,
    producto_id: PRODUCTO,
    usuario_id: JUAN,
    tipo: 'entrada',
    cantidad: 10,
    costo_unitario: COSTO,
    motivo: 'compra de prueba',
    ocurrido_en: ahora(),
  };

  const primera = await pedir('POST', '/sync/push', tokenJuanFer, { movimientos: [movimiento] });
  check('un movimiento nuevo se acepta',
    primera.statusCode === 200 && primera.json().movimientos.aceptados === 1,
    JSON.stringify(primera.json().movimientos));
  check('el movimiento sube el stock', await stockDe(PRODUCTO, TIENDA_FER) === antes + 10,
    `${antes} -> ${await stockDe(PRODUCTO, TIENDA_FER)}`);

  const reenvio = await pedir('POST', '/sync/push', tokenJuanFer, { movimientos: [movimiento] });
  check('IDEMPOTENCIA: el reenvio se marca duplicado',
    reenvio.json().movimientos.duplicados === 1 && reenvio.json().movimientos.aceptados === 0,
    JSON.stringify(reenvio.json().movimientos));
  check('IDEMPOTENCIA: el reenvio no vuelve a mover el stock',
    await stockDe(PRODUCTO, TIENDA_FER) === antes + 10);

  const signoMal = await pedir('POST', '/sync/push', tokenJuanFer, {
    movimientos: [{ ...movimiento, uuid_externo: randomUUID(), tipo: 'entrada', cantidad: -5 }],
  });
  check('una entrada con cantidad negativa se rechaza',
    signoMal.json().movimientos.rechazados[0]?.motivo === 'validacion',
    JSON.stringify(signoMal.json().movimientos.rechazados));

  const tipoVenta = await pedir('POST', '/sync/push', tokenJuanFer, {
    movimientos: [{ ...movimiento, uuid_externo: randomUUID(), tipo: 'venta', cantidad: -1 }],
  });
  check('un movimiento de tipo venta se rechaza (lo genera el servidor)',
    tipoVenta.json().movimientos.rechazados[0]?.motivo === 'validacion',
    JSON.stringify(tipoVenta.json().movimientos.rechazados));

  const tiendaAjena = await pedir('POST', '/sync/push', tokenJuanFer, {
    movimientos: [{ ...movimiento, uuid_externo: randomUUID(), tienda_id: TIENDA_PLA }],
  });
  check('un movimiento para la otra tienda se rechaza por permiso',
    tiendaAjena.json().movimientos.rechazados[0]?.motivo === 'permiso',
    JSON.stringify(tiendaAjena.json().movimientos.rechazados));

  const productoInexistente = await pedir('POST', '/sync/push', tokenJuanFer, {
    movimientos: [{ ...movimiento, uuid_externo: randomUUID(), producto_id: 999999 }],
  });
  const rechazo = productoInexistente.json().movimientos.rechazados[0];
  check('un producto inexistente se rechaza por la base', rechazo?.motivo === 'base_de_datos',
    JSON.stringify(rechazo));
  check('el rechazo de la base no filtra nombres de tablas ni restricciones',
    !/FK_|CONSTRAINT|MOVIMIENTO_INVENTARIO/.test(JSON.stringify(rechazo)),
    JSON.stringify(rechazo));
}

// -----------------------------------------------------------------------------
console.log('\n9. Sincronizacion: ventas');
// -----------------------------------------------------------------------------
{
  const antes = await stockDe(PRODUCTO, TIENDA_FER);
  const uuid = randomUUID();
  const venta = {
    uuid_externo: uuid,
    tienda_id: TIENDA_FER,
    usuario_id: JUAN,
    metodo_pago: 'efectivo',
    subtotal: Math.round(3 * PRECIO * 100) / 100,
    descuento: 0,
    total: Math.round(3 * PRECIO * 100) / 100,
    ocurrido_en: ahora(),
    lineas: [{
      producto_id: PRODUCTO,
      cantidad: 3,
      precio_unitario: PRECIO,
      costo_unitario: COSTO,
      descuento: 0,
      subtotal: Math.round(3 * PRECIO * 100) / 100,
    }],
  };

  const primera = await pedir('POST', '/sync/push', tokenJuanFer, { ventas: [venta] });
  check('una venta nueva se acepta',
    primera.statusCode === 200 && primera.json().ventas.aceptados === 1,
    JSON.stringify(primera.json().ventas));

  const asignado = primera.json().ventas.asignados[0];
  check('el servidor devuelve el numero que le asigno a la venta',
    typeof asignado?.numero === 'number' && asignado.numero > 0, JSON.stringify(asignado));
  check('la venta descuenta el stock', await stockDe(PRODUCTO, TIENDA_FER) === antes - 3,
    `${antes} -> ${await stockDe(PRODUCTO, TIENDA_FER)}`);

  const { rows: guardada } = await db.query(
    'SELECT subtotal, descuento, total, numero FROM VENTA WHERE uuid_externo = @u',
    { u: uuid },
  );
  check('la cabecera guarda el total derivado de las lineas',
    Number(guardada[0].total) === venta.total,
    `esperado ${venta.total}, guardado ${guardada[0].total}`);

  const { rows: movDeVenta } = await db.query(
    `SELECT COUNT(*) AS n FROM MOVIMIENTO_INVENTARIO m
       JOIN VENTA v ON v.id = m.venta_id
      WHERE v.uuid_externo = @u AND m.tipo = 'venta'`,
    { u: uuid },
  );
  check('la venta genero su movimiento de inventario', movDeVenta[0].n === 1);

  const reenvio = await pedir('POST', '/sync/push', tokenJuanFer, { ventas: [venta] });
  check('IDEMPOTENCIA: el reenvio de la venta se marca duplicado',
    reenvio.json().ventas.duplicados === 1 && reenvio.json().ventas.aceptados === 0,
    JSON.stringify(reenvio.json().ventas));
  check('IDEMPOTENCIA: el reenvio NO descuenta el stock dos veces',
    await stockDe(PRODUCTO, TIENDA_FER) === antes - 3,
    `${antes - 3} esperado, hay ${await stockDe(PRODUCTO, TIENDA_FER)}`);

  const { rows: lineasTras } = await db.query(
    `SELECT COUNT(*) AS n FROM VENTA_LINEA l
       JOIN VENTA v ON v.id = l.venta_id WHERE v.uuid_externo = @u`,
    { u: uuid },
  );
  check('IDEMPOTENCIA: el reenvio no duplico las lineas', lineasTras[0].n === 1);

  // Numeracion: dos ventas seguidas tienen que recibir numeros distintos.
  const segunda = await pedir('POST', '/sync/push', tokenJuanFer, {
    ventas: [{ ...venta, uuid_externo: randomUUID(), ocurrido_en: ahora() }],
  });
  check('la segunda venta recibe un numero distinto',
    segunda.json().ventas.asignados[0].numero !== asignado.numero,
    `${asignado.numero} vs ${segunda.json().ventas.asignados[0]?.numero}`);
}

// -----------------------------------------------------------------------------
console.log('\n10. Sincronizacion: lo que no debe entrar');
// -----------------------------------------------------------------------------
{
  const base = {
    tienda_id: TIENDA_FER,
    usuario_id: JUAN,
    ocurrido_en: ahora(),
    lineas: [{
      producto_id: PRODUCTO, cantidad: 2, precio_unitario: PRECIO,
      costo_unitario: COSTO, descuento: 0,
      subtotal: Math.round(2 * PRECIO * 100) / 100,
    }],
    subtotal: Math.round(2 * PRECIO * 100) / 100,
    descuento: 0,
    total: Math.round(2 * PRECIO * 100) / 100,
    metodo_pago: 'efectivo',
  };

  const credito = await pedir('POST', '/sync/push', tokenJuanFer, {
    ventas: [{
      ...base, uuid_externo: randomUUID(),
      metodo_pago: 'credito', cliente_id: CLIENTE_CONSTRUCTORA,
    }],
  });
  const rechazoCredito = credito.json().ventas.rechazados[0];
  check('LA DECISION DEL MODELO: una venta a credito por sync se rechaza',
    rechazoCredito?.motivo === 'regla', JSON.stringify(rechazoCredito));
  check('el rechazo del credito explica que hace falta conexion',
    /conexion/.test(rechazoCredito?.detalles ?? ''), rechazoCredito?.detalles);

  const creditoSinCliente = await pedir('POST', '/sync/push', tokenJuanFer, {
    ventas: [{ ...base, uuid_externo: randomUUID(), metodo_pago: 'credito' }],
  });
  check('una venta a credito sin cliente se rechaza en la validacion',
    creditoSinCliente.json().ventas.rechazados[0]?.motivo === 'validacion');

  const totalMal = await pedir('POST', '/sync/push', tokenJuanFer, {
    ventas: [{ ...base, uuid_externo: randomUUID(), total: 1 }],
  });
  check('una venta con el total mal calculado se rechaza',
    totalMal.json().ventas.rechazados[0]?.motivo === 'validacion',
    JSON.stringify(totalMal.json().ventas.rechazados));

  const repetido = await pedir('POST', '/sync/push', tokenJuanFer, {
    ventas: [{
      ...base, uuid_externo: randomUUID(),
      lineas: [base.lineas[0], base.lineas[0]],
      subtotal: Math.round(4 * PRECIO * 100) / 100,
      total: Math.round(4 * PRECIO * 100) / 100,
    }],
  });
  check('un producto repetido en dos lineas se rechaza',
    repetido.json().ventas.rechazados[0]?.motivo === 'validacion',
    JSON.stringify(repetido.json().ventas.rechazados));

  const sinLineas = await pedir('POST', '/sync/push', tokenJuanFer, {
    ventas: [{ ...base, uuid_externo: randomUUID(), lineas: [] }],
  });
  check('una venta sin lineas se rechaza',
    sinLineas.json().ventas.rechazados[0]?.motivo === 'validacion');

  const loteGigante = await pedir('POST', '/sync/push', tokenJuanFer, {
    ventas: new Array(501).fill(base),
  });
  check('un lote de mas de 500 elementos da 413', loteGigante.statusCode === 413);

  // Aislamiento: un elemento malo no puede arrastrar a los buenos.
  const mezclado = await pedir('POST', '/sync/push', tokenJuanFer, {
    movimientos: [
      {
        uuid_externo: randomUUID(), tienda_id: TIENDA_FER, producto_id: PRODUCTO,
        usuario_id: JUAN, tipo: 'entrada', cantidad: 1, costo_unitario: COSTO,
        ocurrido_en: ahora(),
      },
      { uuid_externo: 'no-es-un-uuid', tienda_id: TIENDA_FER, tipo: 'entrada' },
    ],
  });
  check('AISLAMIENTO: en un lote mezclado entra lo bueno y se aparta lo malo',
    mezclado.json().movimientos.aceptados === 1
    && mezclado.json().movimientos.rechazados.length === 1,
    JSON.stringify(mezclado.json().movimientos));
}

// -----------------------------------------------------------------------------
console.log('\n11. Rebaja por mayoreo');
// -----------------------------------------------------------------------------
{
  const bruto = Math.round(10 * PRECIO * 100) / 100;
  const rebaja = Math.round(bruto * 0.1 * 100) / 100;
  const uuid = randomUUID();

  const conRebaja = await pedir('POST', '/sync/push', tokenJuanFer, {
    ventas: [{
      uuid_externo: uuid, tienda_id: TIENDA_FER, usuario_id: JUAN,
      metodo_pago: 'efectivo', subtotal: bruto, descuento: rebaja,
      total: Math.round((bruto - rebaja) * 100) / 100, ocurrido_en: ahora(),
      lineas: [{
        producto_id: PRODUCTO, cantidad: 10, precio_unitario: PRECIO,
        costo_unitario: COSTO, descuento: rebaja,
        subtotal: Math.round((bruto - rebaja) * 100) / 100,
      }],
    }],
  });
  check('una venta con rebaja por mayoreo se acepta',
    conRebaja.json().ventas.aceptados === 1,
    JSON.stringify(conRebaja.json().ventas));

  const { rows } = await db.query(
    `SELECT l.descuento AS rebaja_linea, v.descuento AS rebaja_cabecera, v.total
       FROM VENTA_LINEA l JOIN VENTA v ON v.id = l.venta_id
      WHERE v.uuid_externo = @u`,
    { u: uuid },
  );
  check('la rebaja queda guardada en la linea', Number(rows[0]?.rebaja_linea) === rebaja,
    `esperado ${rebaja}, guardado ${rows[0]?.rebaja_linea}`);
  check('la cabecera suma la rebaja de las lineas',
    Number(rows[0]?.rebaja_cabecera) === rebaja);
  check('el total descuenta la rebaja',
    Number(rows[0]?.total) === Math.round((bruto - rebaja) * 100) / 100);

  const rebajaExcesiva = await pedir('POST', '/sync/push', tokenJuanFer, {
    ventas: [{
      uuid_externo: randomUUID(), tienda_id: TIENDA_FER, usuario_id: JUAN,
      metodo_pago: 'efectivo', subtotal: bruto, descuento: bruto + 100,
      total: 0, ocurrido_en: ahora(),
      lineas: [{
        producto_id: PRODUCTO, cantidad: 10, precio_unitario: PRECIO,
        costo_unitario: COSTO, descuento: bruto + 100, subtotal: 0,
      }],
    }],
  });
  check('una rebaja mayor que el importe de la linea se rechaza',
    rebajaExcesiva.json().ventas.rechazados.length === 1,
    JSON.stringify(rebajaExcesiva.json().ventas));
}

// -----------------------------------------------------------------------------
console.log('\n12. Credito y cuentas por cobrar');
// -----------------------------------------------------------------------------
{
  const cobrar = await pedir('GET', '/reportes/cuentas-por-cobrar', tokenAdmin);
  check('/reportes/cuentas-por-cobrar responde', cobrar.statusCode === 200, cobrar.body);

  const constructora = cobrar.json().clientes
    .find((c) => c.cliente_id === CLIENTE_CONSTRUCTORA);
  // El seed fia 4260 a la constructora y le registra un abono de 200.
  check('el saldo del cliente es lo fiado menos lo abonado',
    Number(constructora?.saldo) === 4060,
    `saldo ${constructora?.saldo}, fiado ${constructora?.total_fiado}, abonado ${constructora?.total_abonado}`);
  check('el cupo disponible es el limite menos el saldo',
    Number(constructora?.cupo_disponible) === 5000 - 4060,
    `cupo ${constructora?.cupo_disponible}`);

  const soloDeudores = cobrar.json().clientes.every((c) => Number(c.saldo) > 0);
  check('por defecto solo lista a quienes deben algo', soloDeudores);

  const todos = await pedir('GET', '/reportes/cuentas-por-cobrar?todos=1', tokenAdmin);
  check('con todos=1 lista tambien a los que no deben',
    todos.json().clientes.length > cobrar.json().clientes.length,
    `${todos.json().clientes.length} vs ${cobrar.json().clientes.length}`);
}

// -----------------------------------------------------------------------------
console.log('\n13. Cuadre de caja');
// -----------------------------------------------------------------------------
{
  const cuadre = await pedir('GET', '/reportes/cuadre-caja', tokenAdmin);
  check('/reportes/cuadre-caja responde', cuadre.statusCode === 200, cuadre.body);
  check('lista las dos cajas del seed', cuadre.json().cajas.length === 2,
    `${cuadre.json().cajas.length}`);

  const caja1 = cuadre.json().cajas.find((c) => c.tienda_id === TIENDA_FER);
  check('la caja de la ferreteria cuadra', caja1?.cuadra === true,
    `esperado ${caja1?.esperado}, contado ${caja1?.efectivo_contado}, diferencia real ${caja1?.diferencia_real}`);
  check('el esperado incluye los abonos de credito en efectivo',
    Number(caja1?.abonado_efectivo) === 200, `abonado ${caja1?.abonado_efectivo}`);

  const filtrado = await pedir('GET', `/reportes/cuadre-caja?tienda_id=${TIENDA_PLA}`, tokenAdmin);
  check('el cuadre filtra por tienda',
    filtrado.json().cajas.every((c) => c.tienda_id === TIENDA_PLA));
}

// -----------------------------------------------------------------------------
console.log('\n14. Bitacora de sincronizacion');
// -----------------------------------------------------------------------------
{
  const { rows: antes } = await db.query('SELECT COUNT(*) AS n FROM SYNC_LOG');

  await pedir('POST', '/sync/push', tokenJuanFer, {
    dispositivo_id: DISPOSITIVO_FER,
    movimientos: [{
      uuid_externo: randomUUID(), tienda_id: TIENDA_FER, producto_id: PRODUCTO,
      usuario_id: JUAN, tipo: 'ajuste', cantidad: 1, ocurrido_en: ahora(),
    }],
  });

  const { rows: despues } = await db.query('SELECT COUNT(*) AS n FROM SYNC_LOG');
  check('un push con dispositivo deja constancia en SYNC_LOG',
    despues[0].n === antes[0].n + 1, `${antes[0].n} -> ${despues[0].n}`);

  const sinDispositivo = await pedir('POST', '/sync/push', tokenJuanFer, {
    dispositivo_id: 999999,
    movimientos: [{
      uuid_externo: randomUUID(), tienda_id: TIENDA_FER, producto_id: PRODUCTO,
      usuario_id: JUAN, tipo: 'ajuste', cantidad: 1, ocurrido_en: ahora(),
    }],
  });
  check('un dispositivo no registrado no hace fracasar la sincronizacion',
    sinDispositivo.statusCode === 200 && sinDispositivo.json().movimientos.aceptados === 1,
    JSON.stringify(sinDispositivo.json().movimientos));
}

// -----------------------------------------------------------------------------
console.log('\n15. Salida');
// -----------------------------------------------------------------------------
{
  const token = await entrarComoEmpleado(MARIA, MARIA_PIN, TIENDA_PLA);

  const antes = await pedir('GET', '/auth/yo', token);
  check('el token sirve antes de salir', antes.statusCode === 200);

  const salir = await pedir('POST', '/auth/salir', token);
  check('POST /auth/salir responde', salir.statusCode === 200 && salir.json().cerrada === true);

  const despues = await pedir('GET', '/auth/yo', token);
  check('el token deja de servir despues de salir', despues.statusCode === 401);

  const uno = await entrarComoEmpleado(MARIA, MARIA_PIN, TIENDA_PLA);
  const otro = await entrarComoEmpleado(MARIA, MARIA_PIN, TIENDA_PLA);
  const todo = await pedir('POST', '/auth/salir/todo', uno);
  check('POST /auth/salir/todo cierra mas de una sesion', todo.json().cerradas >= 2,
    `cerradas ${todo.json().cerradas}`);

  const otroDespues = await pedir('GET', '/auth/yo', otro);
  check('la otra sesion del mismo usuario tambien quedo cerrada',
    otroDespues.statusCode === 401);
}

// -----------------------------------------------------------------------------
console.log('\n16. Limite de intentos de ingreso');
//
// Va al final a proposito: deja fallos acumulados en la ventana, y un ingreso
// correcto los limpia. Puesto antes, haria fallar a las pruebas de ingreso de
// mas arriba segun el orden en que corran.
// -----------------------------------------------------------------------------
{
  await db.query('DELETE FROM INTENTO_LOGIN');

  let ultimo;
  for (let i = 0; i < 6; i++) {
    ultimo = await pedir('POST', '/auth/login/pin', null,
      { usuario_id: MARIA, tienda_id: TIENDA_PLA, pin: '0000' });
  }
  check('tras varios PIN fallidos responde 429', ultimo.statusCode === 429,
    `codigo ${ultimo.statusCode}: ${ultimo.body}`);
  check('el mensaje dice cuanto hay que esperar', /minutos/.test(ultimo.json().error),
    ultimo.json().error);

  const conPinBueno = await pedir('POST', '/auth/login/pin', null,
    { usuario_id: MARIA, tienda_id: TIENDA_PLA, pin: MARIA_PIN });
  check('el bloqueo rechaza incluso con el PIN correcto', conPinBueno.statusCode === 429);

  const otroUsuario = await pedir('POST', '/auth/login/pin', null,
    { usuario_id: JUAN, tienda_id: TIENDA_FER, pin: JUAN_PIN });
  check('el bloqueo es por usuario y no deja sin vender al companiero',
    otroUsuario.statusCode === 200, otroUsuario.body);

  const { rows: auditoria } = await db.query(
    "SELECT COUNT(*) AS n FROM INTENTO_LOGIN WHERE exitoso = 1");
  check('los ingresos correctos quedan en la auditoria', auditoria[0].n > 0);

  await db.query('DELETE FROM INTENTO_LOGIN');
}

// -----------------------------------------------------------------------------
// Cierre
// -----------------------------------------------------------------------------
console.log('\n=============================================================');
console.log(`RESULTADO: ${pasadas} pasaron, ${fallidas} fallaron`);
console.log('=============================================================\n');

await app.close();
await db.cerrar();
borrarBaseDePrueba();
rmSync(temporal, { recursive: true, force: true });

process.exit(fallidas === 0 ? 0 : 1);
