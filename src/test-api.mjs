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
// Con entradas y no ajustes: desde la seccion 32 un empleado no puede ajustar
// por la cola, y lo que esta seccion mira es la bitacora, no el tipo.
{
  const { rows: antes } = await db.query('SELECT COUNT(*) AS n FROM SYNC_LOG');

  await pedir('POST', '/sync/push', tokenJuanFer, {
    dispositivo_id: DISPOSITIVO_FER,
    movimientos: [{
      uuid_externo: randomUUID(), tienda_id: TIENDA_FER, producto_id: PRODUCTO,
      usuario_id: JUAN, tipo: 'entrada', cantidad: 1, ocurrido_en: ahora(),
    }],
  });

  const { rows: despues } = await db.query('SELECT COUNT(*) AS n FROM SYNC_LOG');
  check('un push con dispositivo deja constancia en SYNC_LOG',
    despues[0].n === antes[0].n + 1, `${antes[0].n} -> ${despues[0].n}`);

  const sinDispositivo = await pedir('POST', '/sync/push', tokenJuanFer, {
    dispositivo_id: 999999,
    movimientos: [{
      uuid_externo: randomUUID(), tienda_id: TIENDA_FER, producto_id: PRODUCTO,
      usuario_id: JUAN, tipo: 'entrada', cantidad: 1, ocurrido_en: ahora(),
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
console.log('\n17. Catalogo: categorias y productos');
// -----------------------------------------------------------------------------
let categoriaNueva;
let productoNuevo;
{
  // La prueba 15 cerro TODAS las sesiones de Maria con /auth/salir/todo, asi
  // que su token de mas arriba ya no vale. Se renueva aca en lugar de mover
  // aquella prueba: que cerrar todo deje sin servir un token obtenido antes es
  // justamente lo que esa prueba verifica.
  tokenMaria = await entrarComoEmpleado(MARIA, MARIA_PIN, TIENDA_PLA);

  const cats = await pedir('GET', '/categorias', tokenJuanFer);
  check('GET /categorias responde al empleado', cats.statusCode === 200, cats.body);
  check('las categorias traen cuantos productos tienen',
    cats.json().categorias.every((c) => typeof c.productos === 'number'));

  const comoEmpleado = await pedir('POST', '/categorias', tokenJuanFer, { nombre: 'X' });
  check('el empleado NO puede crear categorias', comoEmpleado.statusCode === 403);

  const cat = await pedir('POST', '/categorias', tokenAdmin, { nombre: 'Ferreteria Fina' });
  check('el administrador crea una categoria', cat.statusCode === 201, cat.body);
  categoriaNueva = cat.json().id;

  // ---- Productos ----
  const sinPermiso = await pedir('POST', '/productos', tokenJuanFer,
    { nombre: 'Algo', categoria_id: categoriaNueva });
  check('el empleado NO puede crear productos', sinPermiso.statusCode === 403);

  const nuevo = await pedir('POST', '/productos', tokenAdmin, {
    nombre: 'Taladro percutor 650W',
    categoria_id: categoriaNueva,
    precio_costo: 1800,
    precio_venta: 2600,
    unidad_medida: 'Unidad',
  });
  check('el administrador crea un producto', nuevo.statusCode === 201, nuevo.body);
  productoNuevo = nuevo.json().id;

  // EL CASO DEL LEVANTAMIENTO: la mercaderia no viene con codigo.
  const sinCodigo1 = await pedir('POST', '/productos', tokenAdmin,
    { nombre: 'Tornillo suelto a granel', categoria_id: categoriaNueva, codigo: '' });
  const sinCodigo2 = await pedir('POST', '/productos', tokenAdmin,
    { nombre: 'Clavo suelto a granel', categoria_id: categoriaNueva });
  check('se pueden cargar DOS productos sin codigo (el caso real del negocio)',
    sinCodigo1.statusCode === 201 && sinCodigo2.statusCode === 201,
    `${sinCodigo1.statusCode} / ${sinCodigo2.statusCode}: ${sinCodigo1.body} ${sinCodigo2.body}`);
  check('el codigo vacio se guarda como nulo, no como cadena vacia',
    sinCodigo1.json().codigo === null);

  const conCodigo = await pedir('POST', '/productos', tokenAdmin,
    { nombre: 'Martillo con codigo', categoria_id: categoriaNueva, codigo: 'MART-X1' });
  const repetido = await pedir('POST', '/productos', tokenAdmin,
    { nombre: 'Otro martillo', categoria_id: categoriaNueva, codigo: 'MART-X1' });
  check('un codigo repetido se rechaza con 409',
    conCodigo.statusCode === 201 && repetido.statusCode === 409,
    `${conCodigo.statusCode} / ${repetido.statusCode}: ${repetido.body}`);
  check('el 409 no filtra el nombre del indice',
    !/UX_|INDEX|PRODUCTO/.test(repetido.body), repetido.body);

  const categoriaMala = await pedir('POST', '/productos', tokenAdmin,
    { nombre: 'Huerfano', categoria_id: 999999 });
  check('una categoria inexistente se rechaza con 400', categoriaMala.statusCode === 400,
    `${categoriaMala.statusCode}: ${categoriaMala.body}`);

  // ---- Lectura y busqueda ----
  const busqueda = await pedir('GET', '/productos?q=percutor', tokenJuanFer);
  check('el empleado busca productos por nombre',
    busqueda.statusCode === 200 && busqueda.json().productos.length === 1,
    JSON.stringify(busqueda.json().productos?.map((p) => p.nombre)));
  check('la busqueda trae el stock de la tienda de la sesion',
    busqueda.json().tienda_id === TIENDA_FER, `tienda ${busqueda.json().tienda_id}`);

  const porCodigo = await pedir('GET', '/productos?q=MART-X1', tokenAdmin);
  check('la busqueda tambien encuentra por codigo',
    porCodigo.json().productos.length === 1, JSON.stringify(porCodigo.json().productos));

  const detalle = await pedir('GET', `/productos/${productoNuevo}`, tokenAdmin);
  check('el detalle de un producto muestra el stock de LAS DOS tiendas',
    detalle.json().stock.length === 2, JSON.stringify(detalle.json().stock));
  check('un producto recien creado arranca en cero en las dos',
    detalle.json().stock.every((s) => Number(s.cantidad) === 0));

  const inexistente = await pedir('GET', '/productos/999999', tokenAdmin);
  check('un producto inexistente da 404', inexistente.statusCode === 404);

  // ---- Modificacion ----
  const cambio = await pedir('PATCH', `/productos/${productoNuevo}`, tokenAdmin,
    { precio_venta: 2750 });
  check('el administrador cambia un precio', cambio.statusCode === 200, cambio.body);
  const trasCambio = await pedir('GET', `/productos/${productoNuevo}`, tokenAdmin);
  check('el precio nuevo queda guardado',
    Number(trasCambio.json().producto.precio_venta) === 2750,
    `${trasCambio.json().producto.precio_venta}`);

  const vacio = await pedir('PATCH', `/productos/${productoNuevo}`, tokenAdmin, {});
  check('un PATCH sin campos da 400 en lugar de un exito falso', vacio.statusCode === 400);

  const porEmpleado = await pedir('PATCH', `/productos/${productoNuevo}`, tokenJuanFer,
    { precio_venta: 1 });
  check('el empleado NO puede cambiar precios', porEmpleado.statusCode === 403);

  // ---- Baja logica ----
  const baja = await pedir('PATCH', `/productos/${sinCodigo2.json().id}`, tokenAdmin,
    { activo: false });
  check('un producto se da de baja con activo:false', baja.statusCode === 200, baja.body);
  const listaTrasBaja = await pedir('GET', '/productos?q=Clavo suelto', tokenAdmin);
  check('el producto dado de baja desaparece del listado',
    listaTrasBaja.json().productos.length === 0,
    JSON.stringify(listaTrasBaja.json().productos));
  const conInactivos = await pedir('GET', '/productos?q=Clavo suelto&incluir_inactivos=1', tokenAdmin);
  check('pero sigue existiendo para el historial',
    conInactivos.json().productos.length === 1);

  // ---- Stock minimo ----
  const minimo = await pedir('PUT', `/productos/${productoNuevo}/stock-minimo`, tokenAdmin,
    { tienda_id: TIENDA_FER, cantidad_minima: 2 });
  check('se fija el stock minimo de un producto que todavia no tiene stock',
    minimo.statusCode === 200, minimo.body);
  const trasMinimo = await pedir('GET', `/productos/${productoNuevo}`, tokenAdmin);
  const enFer = trasMinimo.json().stock.find((s) => s.tienda_id === TIENDA_FER);
  check('el minimo quedo guardado en la tienda indicada',
    Number(enFer.cantidad_minima) === 2, JSON.stringify(enFer));
}

// -----------------------------------------------------------------------------
console.log('\n18. Movimientos de inventario desde el panel');
// -----------------------------------------------------------------------------
{
  const entrada = await pedir('POST', '/inventario/movimientos', tokenJuanFer, {
    tienda_id: TIENDA_FER, producto_id: productoNuevo, tipo: 'entrada',
    cantidad: 6, costo_unitario: 1800, motivo: 'compra inicial',
  });
  check('el empleado registra una entrada de mercaderia',
    entrada.statusCode === 201, entrada.body);
  check('la respuesta devuelve el stock que quedo',
    entrada.json().stock_resultante === 6, JSON.stringify(entrada.json()));

  const merma = await pedir('POST', '/inventario/movimientos', tokenJuanFer, {
    tienda_id: TIENDA_FER, producto_id: productoNuevo, tipo: 'merma',
    cantidad: -1, motivo: 'se cayo de la estanteria',
  });
  check('el empleado registra una merma', merma.statusCode === 201, merma.body);
  check('la merma baja el stock', merma.json().stock_resultante === 5);

  const ajustePorEmpleado = await pedir('POST', '/inventario/movimientos', tokenJuanFer, {
    tienda_id: TIENDA_FER, producto_id: productoNuevo, tipo: 'ajuste',
    cantidad: 50, motivo: 'conteo fisico',
  });
  check('el empleado NO puede hacer ajustes de inventario',
    ajustePorEmpleado.statusCode === 403, ajustePorEmpleado.body);

  const ajustePorAdmin = await pedir('POST', '/inventario/movimientos', tokenAdmin, {
    tienda_id: TIENDA_FER, producto_id: productoNuevo, tipo: 'ajuste',
    cantidad: 1, motivo: 'conteo fisico de fin de mes',
  });
  check('el administrador si puede', ajustePorAdmin.statusCode === 201, ajustePorAdmin.body);

  const ajusteSinMotivo = await pedir('POST', '/inventario/movimientos', tokenAdmin, {
    tienda_id: TIENDA_FER, producto_id: productoNuevo, tipo: 'ajuste', cantidad: 1,
  });
  check('un ajuste sin motivo se rechaza', ajusteSinMotivo.statusCode === 400,
    ajusteSinMotivo.body);

  const tiendaAjena = await pedir('POST', '/inventario/movimientos', tokenJuanFer, {
    tienda_id: TIENDA_PLA, producto_id: productoNuevo, tipo: 'entrada', cantidad: 1,
  });
  check('no se puede mover inventario de otra tienda', tiendaAjena.statusCode === 403);

  // La alerta de stock tiene que reaccionar: minimo 2, stock 6.
  const bajar = await pedir('POST', '/inventario/movimientos', tokenAdmin, {
    tienda_id: TIENDA_FER, producto_id: productoNuevo, tipo: 'ajuste',
    cantidad: -5, motivo: 'bajar el stock para probar la alerta',
  });
  check('el ajuste negativo deja el stock en 1', bajar.json().stock_resultante === 1,
    JSON.stringify(bajar.json()));
  const alertas = await pedir('GET', '/reportes/resumen', tokenAdmin);
  check('el producto por debajo del minimo aparece en las alertas',
    alertas.json().alertas_stock.some((a) => a.producto === 'Taladro percutor 650W'),
    JSON.stringify(alertas.json().alertas_stock.map((a) => a.producto)));
}

// -----------------------------------------------------------------------------
console.log('\n19. Caja: apertura y cierre');
// -----------------------------------------------------------------------------
let cajaAbierta;
{
  // Las dos cajas del seed estan cerradas, asi que no hay ninguna abierta.
  const antes = await pedir('GET', '/caja/actual', tokenJuanFer);
  check('al empezar no hay caja abierta', antes.json().abierta === false, antes.body);

  const abrir = await pedir('POST', '/caja/apertura', tokenJuanFer,
    { tienda_id: TIENDA_FER, monto_inicial: 500 });
  check('el empleado abre la caja de su tienda', abrir.statusCode === 201, abrir.body);
  cajaAbierta = abrir.json().caja_id;

  const segunda = await pedir('POST', '/caja/apertura', tokenJuanFer,
    { tienda_id: TIENDA_FER, monto_inicial: 100 });
  check('no se puede abrir una SEGUNDA caja en la misma tienda',
    segunda.statusCode === 409, `${segunda.statusCode}: ${segunda.body}`);
  check('y el mensaje explica que hay que cerrar la anterior',
    /cerrarla/.test(segunda.json().error), segunda.json().error);

  const enOtraTienda = await pedir('POST', '/caja/apertura', tokenJuanFer,
    { tienda_id: TIENDA_PLA, monto_inicial: 100 });
  check('el empleado no abre caja en la otra tienda', enOtraTienda.statusCode === 403);

  const ahora2 = await pedir('GET', '/caja/actual', tokenJuanFer);
  check('la caja abierta ya aparece como actual', ahora2.json().abierta === true);
  check('arranca con el monto inicial y nada vendido',
    Number(ahora2.json().caja.monto_inicial) === 500
    && Number(ahora2.json().caja.vendido_efectivo) === 0,
    JSON.stringify(ahora2.json().caja));
}

// -----------------------------------------------------------------------------
console.log('\n20. Venta con conexion');
// -----------------------------------------------------------------------------
{
  const venta = {
    tienda_id: TIENDA_FER, metodo_pago: 'efectivo',
    subtotal: PRECIO * 2, descuento: 0, total: PRECIO * 2,
    lineas: [{
      producto_id: PRODUCTO, cantidad: 2, precio_unitario: PRECIO,
      costo_unitario: COSTO, descuento: 0, subtotal: PRECIO * 2,
    }],
  };

  const antes = await stockDe(PRODUCTO, TIENDA_FER);
  const r = await pedir('POST', '/ventas', tokenJuanFer, venta);
  check('el empleado registra una venta con conexion', r.statusCode === 201, r.body);
  check('la venta entra sola en la caja abierta, sin que el cliente la indique',
    r.json().caja_id === cajaAbierta, `caja ${r.json().caja_id} vs ${cajaAbierta}`);
  check('la venta descuenta el stock', await stockDe(PRODUCTO, TIENDA_FER) === antes - 2);

  const ventaId = r.json().id;
  const detalle = await pedir('GET', `/ventas/${ventaId}`, tokenJuanFer);
  check('el comprobante se puede volver a leer', detalle.statusCode === 200, detalle.body);
  check('el comprobante trae su detalle', detalle.json().lineas.length === 1);
  check('el total del comprobante es el esperado',
    Number(detalle.json().venta.total) === Math.round(PRECIO * 2 * 100) / 100,
    `${detalle.json().venta.total}`);

  const ajena = await pedir('GET', `/ventas/${ventaId}`, tokenMaria);
  check('una empleada de la otra tienda no ve esa venta', ajena.statusCode === 404,
    `codigo ${ajena.statusCode}`);

  const enTiendaAjena = await pedir('POST', '/ventas', tokenJuanFer,
    { ...venta, tienda_id: TIENDA_PLA });
  check('no se puede vender en la otra tienda', enTiendaAjena.statusCode === 403);

  const listado = await pedir('GET', '/ventas', tokenJuanFer);
  check('el listado de ventas solo trae las de su tienda',
    listado.json().ventas.every((v) => v.tienda_id === TIENDA_FER),
    JSON.stringify(listado.json().ventas.map((v) => v.tienda_id)));

  const listadoAdmin = await pedir('GET', '/ventas', tokenAdmin);
  check('el administrador ve las de las dos tiendas',
    new Set(listadoAdmin.json().ventas.map((v) => v.tienda_id)).size === 2);

  // Caja cerrada: una venta en efectivo no tiene donde sumar el dinero.
  const enPla = await pedir('POST', '/ventas', tokenMaria, { ...venta, tienda_id: TIENDA_PLA });
  check('sin caja abierta, una venta en efectivo se rechaza con 409',
    enPla.statusCode === 409, `${enPla.statusCode}: ${enPla.body}`);
  check('y el mensaje dice que hay que abrir la caja',
    /caja/.test(enPla.json().error), enPla.json().error);

  // Con un producto que la plastiqueria SI tiene: PRODUCTO es de la
  // ferreteria y aca hay 0, y desde la seccion 30 eso se rechaza por falta de
  // existencia, que no es lo que esta prueba mira.
  const { rows: [enStockPla] } = await db.query(
    `SELECT TOP 1 s.producto_id, p.precio_venta FROM Stock s JOIN PRODUCTO p ON p.id = s.producto_id
      WHERE s.tienda_id = @t AND s.cantidad >= 2 ORDER BY s.producto_id`, { t: TIENDA_PLA });
  const precioPla = Number(enStockPla.precio_venta);
  const conTarjeta = await pedir('POST', '/ventas', tokenMaria, {
    tienda_id: TIENDA_PLA, metodo_pago: 'tarjeta',
    subtotal: precioPla * 2, descuento: 0, total: precioPla * 2,
    lineas: [{ producto_id: enStockPla.producto_id, cantidad: 2, precio_unitario: precioPla,
               costo_unitario: 0, descuento: 0, subtotal: precioPla * 2 }],
  });
  check('pero una venta con tarjeta no necesita caja abierta',
    conTarjeta.statusCode === 201, conTarjeta.body);
}

// -----------------------------------------------------------------------------
console.log('\n21. Credito: lo que el sync no puede hacer');
// -----------------------------------------------------------------------------
{
  // Constructora El Progreso: limite 5000, saldo 4060, cupo 940.
  const dentroDelCupo = {
    tienda_id: TIENDA_FER, metodo_pago: 'credito', cliente_id: CLIENTE_CONSTRUCTORA,
    subtotal: 500, descuento: 0, total: 500,
    lineas: [{
      producto_id: PRODUCTO, cantidad: 1, precio_unitario: 500,
      costo_unitario: COSTO, descuento: 0, subtotal: 500,
    }],
  };

  const ok = await pedir('POST', '/ventas', tokenJuanFer, dentroDelCupo);
  check('CON CONEXION si se puede fiar (lo que /sync/push rechaza)',
    ok.statusCode === 201, ok.body);

  const estado = await pedir('GET', `/clientes/${CLIENTE_CONSTRUCTORA}/estado-cuenta`, tokenJuanFer);
  check('el saldo del cliente subio con lo fiado',
    Number(estado.json().cliente.saldo) === 4560,
    `saldo ${estado.json().cliente.saldo}`);
  check('el cupo disponible bajo', Number(estado.json().cliente.cupo_disponible) === 440);

  // Ahora el cupo es 440: 600 lo pasa, y el trigger tiene que frenarlo.
  const pasaElLimite = await pedir('POST', '/ventas', tokenJuanFer, {
    ...dentroDelCupo,
    subtotal: 600, total: 600,
    lineas: [{ ...dentroDelCupo.lineas[0], precio_unitario: 600, subtotal: 600 }],
  });
  check('EL TRIGGER FRENA la venta que pasa el limite de credito',
    pasaElLimite.statusCode === 409, `${pasaElLimite.statusCode}: ${pasaElLimite.body}`);
  check('el mensaje del rechazo es el del esquema, legible por una persona',
    /limite del cliente/.test(pasaElLimite.json().error), pasaElLimite.json().error);

  // Y lo importante: la transaccion se revirtio ENTERA.
  const trasRechazo = await pedir('GET', `/clientes/${CLIENTE_CONSTRUCTORA}/estado-cuenta`, tokenJuanFer);
  check('la venta rechazada no dejo nada a medias: el saldo no cambio',
    Number(trasRechazo.json().cliente.saldo) === 4560,
    `saldo ${trasRechazo.json().cliente.saldo}`);
  check('tampoco quedo la venta suelta',
    trasRechazo.json().ventas_fiadas.every((v) => Number(v.total) !== 600),
    JSON.stringify(trasRechazo.json().ventas_fiadas.map((v) => v.total)));

  const clienteAjeno = await pedir('POST', '/ventas', tokenJuanFer,
    { ...dentroDelCupo, cliente_id: 999999 });
  check('fiar a un cliente inexistente se rechaza con 400',
    clienteAjeno.statusCode === 400, clienteAjeno.body);
}

// -----------------------------------------------------------------------------
console.log('\n22. Clientes y abonos');
// -----------------------------------------------------------------------------
let clienteNuevo;
{
  const lista = await pedir('GET', '/clientes', tokenJuanFer);
  check('el empleado ve la lista de clientes con su saldo',
    lista.statusCode === 200 && lista.json().clientes.every((c) => c.saldo !== undefined),
    lista.body.slice(0, 200));

  const nuevo = await pedir('POST', '/clientes', tokenJuanFer,
    { nombre: 'Rosa Jimenez', telefono: '8555-9900' });
  check('el empleado puede dar de alta un cliente', nuevo.statusCode === 201, nuevo.body);
  check('el cliente nuevo nace con el limite por omision de 1000',
    nuevo.json().limite_credito === 1000, `${nuevo.json().limite_credito}`);
  clienteNuevo = nuevo.json().id;

  const subirLimite = await pedir('PATCH', `/clientes/${clienteNuevo}`, tokenJuanFer,
    { limite_credito: 90000 });
  check('el empleado NO puede cambiar el limite de credito',
    subirLimite.statusCode === 403, subirLimite.body);

  const porAdmin = await pedir('PATCH', `/clientes/${clienteNuevo}`, tokenAdmin,
    { limite_credito: 2500 });
  check('el administrador si puede', porAdmin.statusCode === 200, porAdmin.body);
  check('la respuesta muestra el cupo que quedo',
    Number(porAdmin.json().estado.cupo_disponible) === 2500,
    JSON.stringify(porAdmin.json().estado));

  // ---- Abonos ----
  const abono = await pedir('POST', `/clientes/${CLIENTE_CONSTRUCTORA}/abonos`, tokenJuanFer,
    { monto: 1000, metodo_pago: 'efectivo' });
  check('el empleado registra un abono', abono.statusCode === 201, abono.body);
  check('el abono entra solo en la caja abierta',
    abono.json().caja_id === cajaAbierta, `${abono.json().caja_id}`);
  check('la respuesta dice el saldo que le queda al cliente',
    abono.json().saldo_restante === 3560, `${abono.json().saldo_restante}`);

  const parcial = await pedir('POST', `/clientes/${CLIENTE_CONSTRUCTORA}/abonos`, tokenJuanFer,
    { monto: 60.5, metodo_pago: 'efectivo' });
  check('LOS ABONOS SON PARCIALES: se acepta cualquier monto',
    parcial.statusCode === 201 && parcial.json().saldo_restante === 3499.5,
    `${parcial.statusCode}: ${parcial.json().saldo_restante}`);

  const cero = await pedir('POST', `/clientes/${CLIENTE_CONSTRUCTORA}/abonos`, tokenJuanFer,
    { monto: 0 });
  check('un abono de cero se rechaza', cero.statusCode === 400);

  const aInexistente = await pedir('POST', '/clientes/999999/abonos', tokenJuanFer,
    { monto: 10 });
  check('un abono a un cliente inexistente da 404', aInexistente.statusCode === 404);

  const credito = await pedir('POST', `/clientes/${CLIENTE_CONSTRUCTORA}/abonos`, tokenJuanFer,
    { monto: 10, metodo_pago: 'credito' });
  check('no se puede abonar "al credito"', credito.statusCode === 400, credito.body);

  const cuenta = await pedir('GET', `/clientes/${CLIENTE_CONSTRUCTORA}/estado-cuenta`, tokenAdmin);
  check('el estado de cuenta lista las ventas fiadas y los abonos',
    cuenta.json().ventas_fiadas.length >= 2 && cuenta.json().abonos.length >= 3,
    `${cuenta.json().ventas_fiadas.length} fiadas, ${cuenta.json().abonos.length} abonos`);
  check('cada abono dice quien lo recibio',
    cuenta.json().abonos.every((a) => a.recibido_por !== undefined));
}

// -----------------------------------------------------------------------------
console.log('\n23. Cierre de caja con el dinero del turno');
// -----------------------------------------------------------------------------
{
  const actual = await pedir('GET', '/caja/actual', tokenJuanFer);
  const esperado = Number(actual.json().caja.esperado);
  check('lo esperado incluye las ventas en efectivo Y los abonos del turno',
    Number(actual.json().caja.vendido_efectivo) > 0
    && Number(actual.json().caja.abonado_efectivo) === 1060.5,
    JSON.stringify(actual.json().caja));

  const porOtro = await pedir('POST', `/caja/${cajaAbierta}/cierre`, tokenMaria,
    { efectivo_contado: esperado });
  check('un empleado no cierra la caja de otra tienda', porOtro.statusCode === 403,
    `${porOtro.statusCode}: ${porOtro.body}`);

  const cerrar = await pedir('POST', `/caja/${cajaAbierta}/cierre`, tokenJuanFer,
    { efectivo_contado: esperado, observaciones: 'turno normal' });
  check('el empleado cierra su caja', cerrar.statusCode === 200, cerrar.body);
  check('la diferencia la calculo el servidor, no el empleado',
    cerrar.json().diferencia === 0 && cerrar.json().resultado === 'cuadra',
    JSON.stringify(cerrar.json()));

  const devuelta = await pedir('POST', `/caja/${cajaAbierta}/cierre`, tokenJuanFer,
    { efectivo_contado: esperado });
  check('cerrar dos veces la misma caja da 409', devuelta.statusCode === 409);

  // Un faltante: se abre otra caja y se cuenta de menos.
  const otra = await pedir('POST', '/caja/apertura', tokenJuanFer,
    { tienda_id: TIENDA_FER, monto_inicial: 1000 });
  const faltante = await pedir('POST', `/caja/${otra.json().caja_id}/cierre`, tokenJuanFer,
    { efectivo_contado: 940 });
  check('un faltante se informa con signo negativo',
    faltante.json().diferencia === -60 && faltante.json().resultado === 'faltante',
    JSON.stringify(faltante.json()));

  const cuadre = await pedir('GET', `/caja/${cajaAbierta}`, tokenAdmin);
  // Dos abonos entraron en esta caja (1000 y 60.5); el tercero del cliente es
  // el que trae el seed, y pertenece a la caja 1.
  check('el detalle de la caja lista sus ventas y sus abonos',
    cuadre.json().ventas.length > 0 && cuadre.json().abonos.length === 2,
    `${cuadre.json().ventas.length} ventas, ${cuadre.json().abonos.length} abonos`);
  check('la caja cerrada cuadra en la vista', cuadre.json().caja.cuadra === true,
    JSON.stringify(cuadre.json().caja));
}

// -----------------------------------------------------------------------------
console.log('\n24. Anulacion de ventas');
// -----------------------------------------------------------------------------
{
  const antes = await stockDe(PRODUCTO, TIENDA_FER);
  const abrir = await pedir('POST', '/caja/apertura', tokenJuanFer,
    { tienda_id: TIENDA_FER, monto_inicial: 0 });

  const venta = await pedir('POST', '/ventas', tokenJuanFer, {
    tienda_id: TIENDA_FER, metodo_pago: 'efectivo',
    subtotal: PRECIO, descuento: 0, total: PRECIO,
    lineas: [{
      producto_id: PRODUCTO, cantidad: 1, precio_unitario: PRECIO,
      costo_unitario: COSTO, descuento: 0, subtotal: PRECIO,
    }],
  });
  check('se registra la venta que se va a anular', venta.statusCode === 201, venta.body);
  const ventaId = venta.json().id;

  const porEmpleado = await pedir('POST', `/ventas/${ventaId}/anular`, tokenJuanFer,
    { motivo: 'me equivoque' });
  check('el empleado NO puede anular una venta', porEmpleado.statusCode === 403,
    porEmpleado.body);

  const sinMotivo = await pedir('POST', `/ventas/${ventaId}/anular`, tokenAdmin, {});
  check('anular sin motivo se rechaza', sinMotivo.statusCode === 400, sinMotivo.body);

  const anular = await pedir('POST', `/ventas/${ventaId}/anular`, tokenAdmin,
    { motivo: 'el cliente devolvio la mercaderia' });
  check('el administrador anula la venta', anular.statusCode === 200, anular.body);
  check('la mercaderia volvio al stock', await stockDe(PRODUCTO, TIENDA_FER) === antes,
    `${antes} esperado, hay ${await stockDe(PRODUCTO, TIENDA_FER)}`);

  const otraVez = await pedir('POST', `/ventas/${ventaId}/anular`, tokenAdmin,
    { motivo: 'de nuevo' });
  check('anular dos veces da 409', otraVez.statusCode === 409);

  const detalle = await pedir('GET', `/ventas/${ventaId}`, tokenAdmin);
  check('LA VENTA NO SE BORRO: sigue existiendo, marcada como anulada',
    detalle.statusCode === 200 && detalle.json().venta.anulada === true,
    JSON.stringify(detalle.json().venta.anulada));
  check('el motivo quedo registrado',
    /devolvio la mercaderia/.test(detalle.json().venta.observaciones ?? ''),
    detalle.json().venta.observaciones);
  check('el movimiento de devolucion quedo en el historial del producto',
    (await pedir('GET', `/reportes/movimientos/${PRODUCTO}`, tokenAdmin))
      .json().movimientos.some((m) => m.tipo === 'devolucion'));

  await pedir('POST', `/caja/${abrir.json().caja_id}/cierre`, tokenJuanFer,
    { efectivo_contado: 0 });
}

// -----------------------------------------------------------------------------
console.log('\n25. Usuarios');
// -----------------------------------------------------------------------------
{
  const porEmpleado = await pedir('GET', '/usuarios', tokenJuanFer);
  check('el empleado NO ve la lista de usuarios', porEmpleado.statusCode === 403);

  const lista = await pedir('GET', '/usuarios', tokenAdmin);
  check('el administrador ve la lista', lista.statusCode === 200, lista.body);
  check('la lista NO expone ningun hash',
    !/scrypt|hash":"/.test(lista.body), lista.body.slice(0, 200));
  check('pero si dice quien tiene PIN y quien clave',
    lista.json().usuarios.every((u) => typeof u.tiene_pin === 'boolean'));
  check('y en que tiendas trabaja cada uno',
    lista.json().usuarios.find((u) => u.nombre.startsWith('Juan')).tiendas.includes(','),
    JSON.stringify(lista.json().usuarios.map((u) => u.tiendas)));

  const sinPin = await pedir('POST', '/usuarios', tokenAdmin,
    { nombre: 'Sin Credenciales', rol: 'empleado', tiendas: [TIENDA_FER] });
  check('un empleado sin PIN se rechaza', sinPin.statusCode === 400, sinPin.body);

  const sinTienda = await pedir('POST', '/usuarios', tokenAdmin,
    { nombre: 'Sin Tienda', rol: 'empleado', pin: '4321' });
  check('un empleado sin tienda se rechaza', sinTienda.statusCode === 400, sinTienda.body);

  const nuevo = await pedir('POST', '/usuarios', tokenAdmin, {
    nombre: 'Ana Mostrador', rol: 'empleado', pin: '4321',
    tiendas: [TIENDA_FER, TIENDA_PLA],
  });
  check('se crea un empleado asignado a LAS DOS tiendas',
    nuevo.statusCode === 201, nuevo.body);
  const anaId = nuevo.json().id;
  check('la respuesta no devuelve el PIN', !/4321/.test(nuevo.body), nuevo.body);

  const entraEnFer = await pedir('POST', '/auth/login/pin', null,
    { usuario_id: anaId, tienda_id: TIENDA_FER, pin: '4321' });
  const entraEnPla = await pedir('POST', '/auth/login/pin', null,
    { usuario_id: anaId, tienda_id: TIENDA_PLA, pin: '4321' });
  check('la empleada nueva puede entrar en las dos tiendas',
    entraEnFer.statusCode === 200 && entraEnPla.statusCode === 200,
    `${entraEnFer.statusCode} / ${entraEnPla.statusCode}`);

  // Quitarle una tienda tiene que cerrarle las sesiones.
  const quitar = await pedir('PATCH', `/usuarios/${anaId}`, tokenAdmin,
    { tiendas: [TIENDA_FER] });
  check('se le quita una tienda', quitar.statusCode === 200, quitar.body);
  check('y eso le cierra las sesiones abiertas', quitar.json().sesiones_cerradas >= 2,
    `${quitar.json().sesiones_cerradas}`);
  const yaNoEntra = await pedir('POST', '/auth/login/pin', null,
    { usuario_id: anaId, tienda_id: TIENDA_PLA, pin: '4321' });
  check('ya no puede entrar en la tienda que le quitaron',
    yaNoEntra.statusCode === 403, `${yaNoEntra.statusCode}: ${yaNoEntra.body}`);

  const seMismo = await pedir('PATCH', `/usuarios/${(await pedir('GET', '/auth/yo', tokenAdmin)).json().usuario.id}`,
    tokenAdmin, { activo: false });
  check('el administrador no puede darse de baja a si mismo',
    seMismo.statusCode === 409, seMismo.body);

  // ---- Reinicio de PIN ----
  const reiniciar = await pedir('POST', `/usuarios/${anaId}/pin`, tokenAdmin, { pin: '8765' });
  check('el administrador reinicia el PIN de un empleado',
    reiniciar.statusCode === 200, reiniciar.body);
  const conNuevo = await pedir('POST', '/auth/login/pin', null,
    { usuario_id: anaId, tienda_id: TIENDA_FER, pin: '8765' });
  check('el PIN nuevo sirve', conNuevo.statusCode === 200, conNuevo.body);
  const conViejo = await pedir('POST', '/auth/login/pin', null,
    { usuario_id: anaId, tienda_id: TIENDA_FER, pin: '4321' });
  check('el PIN viejo ya no sirve', conViejo.statusCode === 401);

  const aUnAdmin = await pedir('POST', '/usuarios/1/pin', tokenAdmin, { pin: '1111' });
  check('no se le pone PIN a un administrador por esta via',
    aUnAdmin.statusCode === 404, aUnAdmin.body);
}

// -----------------------------------------------------------------------------
console.log('\n26. Cambio de la propia clave');
// -----------------------------------------------------------------------------
{
  const token = await entrarComoEmpleado(MARIA, MARIA_PIN, TIENDA_PLA);

  const mal = await pedir('POST', '/mi-pin', token, { actual: '0000', nuevo: '1111' });
  check('cambiar el PIN con el actual equivocado da 401', mal.statusCode === 401, mal.body);

  const claveEnCuentaDePin = await pedir('POST', '/mi-clave', token,
    { actual: 'x', nueva: 'unaclavelarga' });
  check('una cuenta de PIN no cambia contrasenia', claveEnCuentaDePin.statusCode === 409,
    claveEnCuentaDePin.body);

  const bien = await pedir('POST', '/mi-pin', token, { actual: MARIA_PIN, nuevo: '2468' });
  check('el empleado cambia su propio PIN', bien.statusCode === 200, bien.body);
  check('el cambio cierra TODAS sus sesiones, incluida la actual',
    bien.json().debe_volver_a_entrar === true && bien.json().sesiones_cerradas >= 1,
    JSON.stringify(bien.json()));

  const tokenViejo = await pedir('GET', '/auth/yo', token);
  check('el token con el que lo cambio ya no sirve', tokenViejo.statusCode === 401);

  const conNuevo = await pedir('POST', '/auth/login/pin', null,
    { usuario_id: MARIA, tienda_id: TIENDA_PLA, pin: '2468' });
  check('entra con el PIN nuevo', conNuevo.statusCode === 200, conNuevo.body);

  // Y lo deja como estaba, igual que la contrasenia del administrador mas
  // abajo: si no, toda seccion posterior que entre como Maria falla.
  const devuelto = await pedir('POST', '/mi-pin', conNuevo.json().token, { actual: '2468', nuevo: MARIA_PIN });
  check('el PIN del seed quedo restaurado', devuelto.statusCode === 200, devuelto.body);

  // El administrador cambia su contrasenia y la deja como estaba, para que el
  // resto de las pruebas y el seed sigan siendo coherentes.
  const tokenA = await entrarComoAdmin();
  const cambio = await pedir('POST', '/mi-clave', tokenA,
    { actual: ADMIN_CLAVE, nueva: 'otraclavelarga2026' });
  check('el administrador cambia su contrasenia', cambio.statusCode === 200, cambio.body);
  const conVieja = await pedir('POST', '/auth/login/admin', null,
    { email: ADMIN_EMAIL, password: ADMIN_CLAVE });
  check('la contrasenia vieja ya no sirve', conVieja.statusCode === 401);
  const conNueva = await pedir('POST', '/auth/login/admin', null,
    { email: ADMIN_EMAIL, password: 'otraclavelarga2026' });
  check('la nueva si', conNueva.statusCode === 200, conNueva.body);

  const corta = await pedir('POST', '/mi-clave', conNueva.json().token,
    { actual: 'otraclavelarga2026', nueva: 'corta' });
  check('una contrasenia de menos de 8 caracteres se rechaza', corta.statusCode === 400);

  // Se deja la contrasenia como estaba y se renueva el token: cambiarla revoco
  // todas las sesiones del administrador, incluida la de las pruebas de arriba.
  await pedir('POST', '/mi-clave', conNueva.json().token,
    { actual: 'otraclavelarga2026', nueva: ADMIN_CLAVE });
  tokenAdmin = await entrarComoAdmin();
  check('la contrasenia del seed quedo restaurada', typeof tokenAdmin === 'string');
}

// -----------------------------------------------------------------------------
console.log('\n27. Zona horaria: el dia del reporte es el dia del negocio');
//
// Esta seccion existe por un error que estuvo en el esquema sin fallar nunca:
// las vistas agrupaban por fecha UTC y Nicaragua es UTC-6, asi que las ventas
// de la tarde se contaban en el dia siguiente. No habia excepcion ni numero
// absurdo, solo el total del dia corrido.
//
// Prueba el viaje completo: la tablet manda la hora local con su desplazamiento,
// se guarda en UTC, y el reporte la devuelve al dia del negocio.
// -----------------------------------------------------------------------------
{
  // 18:30 y 23:40 del 14 de enero en Nicaragua. En UTC las dos caen el 15.
  const TARDE = '2026-01-14T18:30:00-06:00';
  const NOCHE = '2026-01-14T23:40:00-06:00';
  const DIA_LOCAL = '2026-01-14';
  const DIA_UTC = '2026-01-15';

  const linea = (precio) => ({
    producto_id: PRODUCTO, cantidad: 1, precio_unitario: precio,
    costo_unitario: COSTO, descuento: 0, subtotal: precio,
  });
  const venta = (uuid, cuando, precio) => ({
    uuid_externo: uuid, tienda_id: TIENDA_FER, usuario_id: JUAN,
    metodo_pago: 'efectivo', subtotal: precio, descuento: 0, total: precio,
    ocurrido_en: cuando, lineas: [linea(precio)],
  });

  const envio = await pedir('POST', '/sync/push', tokenJuanFer, {
    ventas: [venta(randomUUID(), TARDE, 100), venta(randomUUID(), NOCHE, 250)],
  });
  check('entran las dos ventas de la tarde y la noche',
    envio.json().ventas.aceptados === 2, JSON.stringify(envio.json().ventas));

  // Lo que la base guardo tiene que ser el instante UTC, no la hora de pared.
  const { rows: guardadas } = await db.query(
    `SELECT ocurrido_en, dbo.fn_fecha_local(ocurrido_en) AS fecha_local
       FROM VENTA WHERE numero IN (
         SELECT TOP 2 numero FROM VENTA WHERE tienda_id = @t ORDER BY id DESC)
        AND tienda_id = @t`,
    { t: TIENDA_FER },
  );
  check('la hora con desplazamiento se guardo convertida a UTC',
    guardadas.every((v) => v.ocurrido_en.toISOString().startsWith('2026-01-15')),
    JSON.stringify(guardadas.map((v) => v.ocurrido_en.toISOString())));
  check('pero su fecha local es la del dia anterior',
    guardadas.every((v) => v.fecha_local.toISOString().startsWith(DIA_LOCAL)),
    JSON.stringify(guardadas.map((v) => v.fecha_local)));

  // EL REPORTE: las dos ventas en el dia local, ninguna en el dia UTC.
  const enLocal = await pedir('GET', `/reportes/resumen?fecha=${DIA_LOCAL}`, tokenAdmin);
  const fer = enLocal.json().por_tienda.find((t) => t.tienda_id === TIENDA_FER);
  check('el reporte del dia local cuenta las dos ventas',
    fer?.cantidad_ventas === 2 && Number(fer?.total_vendido) === 350,
    JSON.stringify(fer));

  const enUtc = await pedir('GET', `/reportes/resumen?fecha=${DIA_UTC}`, tokenAdmin);
  check('el reporte del dia UTC no cuenta ninguna',
    enUtc.json().por_tienda.length === 0, JSON.stringify(enUtc.json().por_tienda));

  check('la respuesta dice por que dia agrupo',
    enLocal.json().fecha === DIA_LOCAL, enLocal.json().fecha);

  // La serie diaria, que filtra sobre la misma columna de la vista.
  const serie = await pedir('GET',
    `/reportes/ventas?desde=${DIA_LOCAL}&hasta=${DIA_LOCAL}`, tokenAdmin);
  check('la serie diaria encuentra el dia local',
    serie.json().ventas.some((v) => Number(v.total_vendido) === 350),
    JSON.stringify(serie.json().ventas));

  // EL FILTRO DE RANGO, que compara contra la columna UTC y por eso traduce los
  // extremos: es el camino que no pasa por la vista.
  const rango = await pedir('GET',
    `/ventas?desde=${DIA_LOCAL}&hasta=${DIA_LOCAL}&tienda_id=${TIENDA_FER}`, tokenAdmin);
  check('el rango de /ventas encuentra las dos, aunque en UTC sean del dia siguiente',
    rango.json().ventas.length === 2, `${rango.json().ventas.length} ventas`);

  const rangoUtc = await pedir('GET',
    `/ventas?desde=${DIA_UTC}&hasta=${DIA_UTC}&tienda_id=${TIENDA_FER}`, tokenAdmin);
  check('y pedir el dia UTC no devuelve ninguna',
    rangoUtc.json().ventas.length === 0, `${rangoUtc.json().ventas.length} ventas`);

  // El limite del dia: la venta de las 23:40 no se puede escapar al dia
  // siguiente, que es el error que aparece cuando el rango se arma sumando
  // 23:59:59 en lugar de usar el inicio del dia siguiente.
  const soloDiaSiguiente = await pedir('GET',
    `/ventas?desde=2026-01-15&hasta=2026-01-15&tienda_id=${TIENDA_FER}`, tokenAdmin);
  check('ninguna se escapa al dia siguiente',
    soloDiaSiguiente.json().ventas.length === 0,
    `${soloDiaSiguiente.json().ventas.length} ventas`);

  // "Hoy" por omision.
  //
  // CUIDADO CON COMO SE PRUEBA ESTO: comparar contra la fecha UTC solo
  // distingue algo entre medianoche y las 06:00 UTC, que son las unicas seis
  // horas del dia en que las dos fechas diferen. Corriendo a cualquier otra
  // hora, una API que usara la fecha UTC pasaria la prueba igual.
  //
  // Asi que se compara contra lo que dice la BASE, que es lo que la vista usa
  // para agrupar. Eso prueba el cableado -- que la ruta pregunta lo correcto --
  // y las pruebas del esquema ya prueban que la funcion convierte bien.
  const { rows: segunLaBase } = await db.query(
    `SELECT dbo.fn_fecha_local(SYSUTCDATETIME()) AS local,
            CAST(SYSUTCDATETIME() AS DATE)       AS utc`,
  );
  const localDeLaBase = segunLaBase[0].local.toISOString().slice(0, 10);
  const utcDeLaBase = segunLaBase[0].utc.toISOString().slice(0, 10);

  const hoy = await pedir('GET', '/reportes/resumen', tokenAdmin);
  check('sin fecha, el resumen agrupa por el mismo dia local que la vista',
    hoy.json().fecha === localDeLaBase,
    `la API dice ${hoy.json().fecha}, la base ${localDeLaBase}`);

  // Y se deja constancia de si esta corrida pudo distinguirlo o no, para que
  // nadie lea un OK de arriba como mas fuerte de lo que es.
  console.log(localDeLaBase === utcDeLaBase
    ? `        (nota: a esta hora el dia local y el UTC coinciden en ${localDeLaBase};`
      + ' la distincion la cubren las pruebas del esquema)'
    : `        (nota: ahora mismo el dia local es ${localDeLaBase} y el UTC ${utcDeLaBase}:`
      + ' esta corrida si los distingue)');

  // Un camino independiente del de la base: la hora de Nicaragua calculada en
  // JavaScript. Nicaragua no tiene horario de verano, asi que restar seis horas
  // es exacto, y si los dos lados coinciden la conversion es la misma.
  const hoyEnJs = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString().slice(0, 10);
  check('la base y JavaScript calculan el mismo dia de Nicaragua',
    localDeLaBase === hoyEnJs, `base ${localDeLaBase}, JavaScript ${hoyEnJs}`);
}

// -----------------------------------------------------------------------------
console.log('\n28. Rebajas con centavos: la aritmetica no rechaza ventas validas');
// -----------------------------------------------------------------------------
// La validacion de la linea comparaba cantidad x precio - rebaja SIN redondear
// contra el subtotal redondeado. En punto flotante 2 x 0.20 - 0.10 da
// 0.30000000000000004, distinto de 0.3, y la venta se rechazaba con "el
// subtotal no coincide". Le pasaba a cualquier rebaja con centavos, que es
// justo la rebaja por mayoreo que el mostrador negocia.
{
  const { EsquemaLineaVenta } = await import('./validacion.mjs');
  const r2 = (n) => Math.round(n * 100) / 100;
  let rechazadas = 0, probadas = 0, ejemplo = '';
  for (let centavos = 10; centavos <= 30000; centavos += 10) {
    const precio = centavos / 100;
    for (const cantidad of [1, 2, 3, 1.5, 0.25, 12]) {
      for (const descuento of [0.1, 0.2, 0.3, 0.7, 1.1, 2.35]) {
        if (descuento > r2(cantidad * precio)) continue;
        probadas++;
        const linea = { producto_id: 1, cantidad, precio_unitario: precio, descuento,
                        subtotal: r2(r2(cantidad * precio) - descuento) };
        if (!EsquemaLineaVenta.safeParse(linea).success) {
          rechazadas++;
          ejemplo ||= `${cantidad} x ${precio} - ${descuento}`;
        }
      }
    }
  }
  check(`ninguna de ${probadas} lineas validas con rebaja se rechaza`, rechazadas === 0,
    `${rechazadas} rechazadas, por ejemplo ${ejemplo}`);

  // Y de punta a punta, por la API: la venta del ejemplo tiene que entrar.
  const venta = {
    tienda_id: TIENDA_FER, metodo_pago: 'tarjeta',
    subtotal: 0.4, descuento: 0.1, total: 0.3,
    lineas: [{ producto_id: PRODUCTO, cantidad: 2, precio_unitario: 0.2,
               costo_unitario: 0, descuento: 0.1, subtotal: 0.3 }],
  };
  const r = await pedir('POST', '/ventas', tokenJuanFer, venta);
  check('2 x 0.20 con 0.10 de rebaja se registra', r.statusCode === 201, r.body);

  // La comprobacion sigue existiendo: un subtotal que de verdad no cuadra
  // se rechaza igual que antes.
  const mal = await pedir('POST', '/ventas', tokenJuanFer, {
    ...venta, total: 0.31,
    lineas: [{ ...venta.lineas[0], subtotal: 0.31 }],
  });
  check('un subtotal que no cuadra por un centavo se sigue rechazando', mal.statusCode === 400, mal.body);
}

// -----------------------------------------------------------------------------
console.log('\n29. Punto de venta: la aplicacion y lo que arma la tablet');
// -----------------------------------------------------------------------------
// La aplicacion se sirve desde la misma API, sin sesion (la pantalla de
// ingreso tiene que cargar antes de tener token). Y lo que arma la tablet
// (cliente/logica.js) se comprueba contra los mismos esquemas del servidor:
// una venta que el servidor rechaza ya tiene el ticket entregado.
{
  const pagina = await pedir('GET', '/app/');
  check('la pagina del punto de venta carga sin sesion', pagina.statusCode === 200
    && /text\/html/.test(pagina.headers['content-type']), `${pagina.statusCode}`);
  const sw = await pedir('GET', '/app/sw.js');
  check('el service worker se sirve como JavaScript', sw.statusCode === 200
    && /javascript/.test(sw.headers['content-type']));
  const raiz = await pedir('GET', '/');
  check('la raiz lleva al punto de venta', raiz.statusCode === 302 && raiz.headers.location === '/app/');

  // Nadie puede leer el codigo del servidor por la puerta de la aplicacion.
  for (const url of ['/app/../src/db.mjs', '/app/..%2Fsrc%2Fdb.mjs', '/app/%2e%2e/package.json',
                     '/app/..%5Csrc%5Cdb.mjs']) {
    const r = await pedir('GET', url);
    check(`no se sale de cliente/: ${url}`, r.statusCode === 404 && !/import|"dependencies"/.test(r.body),
      `${r.statusCode}`);
  }
  check('las rutas de datos siguen cerradas', (await pedir('GET', '/sync/catalogo/1')).statusCode === 401);

  const L = await import('../cliente/logica.js');
  const { EsquemaVenta } = await import('./validacion.mjs');

  // Miles de carritos al azar, con cantidades fraccionarias y rebajas con
  // centavos: todos tienen que pasar la validacion del servidor tal cual.
  let semilla = 7;
  const azar = () => { semilla = (semilla * 16807) % 2147483647; return semilla / 2147483647; };
  let malos = 0, primero = '';
  for (let n = 0; n < 3000; n++) {
    let carrito = [];
    const lineas = 1 + Math.floor(azar() * 6);
    for (let k = 0; k < lineas; k++) {
      const precio = Math.round(azar() * 150000) / 100;
      carrito = L.agregar(carrito, { id: 1 + Math.floor(azar() * 40), nombre: 'p', precio_venta: precio,
                                     precio_costo: precio / 2 },
                          [1, 2, 3, 0.5, 1.25, 12][Math.floor(azar() * 6)]);
    }
    carrito = carrito.map((it) => ({ ...it,
      descuento: azar() < 0.5 ? 0 : Math.round(azar() * it.cantidad * it.precio_unitario * 30) / 100 }));
    if (L.problemasDelCarrito(carrito).length) continue;
    const v = L.armarVenta({ carrito, tienda_id: 1, usuario_id: 2 });
    const r = EsquemaVenta.safeParse(v);
    if (!r.success) { malos++; primero ||= JSON.stringify(r.error.issues[0]); }
  }
  check('3000 carritos armados por la tablet pasan la validacion del servidor', malos === 0,
    `${malos} rechazados; ${primero}`);

  const u = L.nuevoUuid();
  check('la tablet genera identificadores que el servidor acepta',
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(u), u);

  // De punta a punta por /sync/push: dos ventas buenas y una a credito, que
  // por este camino se rechaza. Despues, el reenvio del mismo lote (la
  // respuesta se perdio en el camino).
  const item = { id: PRODUCTO, nombre: 'x', precio_venta: PRECIO, precio_costo: COSTO };
  const v1 = L.armarVenta({ carrito: L.agregar([], item, 1), tienda_id: TIENDA_FER, usuario_id: JUAN });
  const v2 = L.armarVenta({ carrito: [{ ...L.agregar([], item, 3)[0], descuento: 0.1 }],
                            tienda_id: TIENDA_FER, usuario_id: JUAN });
  const v3 = L.armarVenta({ carrito: L.agregar([], item, 1), tienda_id: TIENDA_FER, usuario_id: JUAN,
                            metodo_pago: 'credito', cliente_id: CLIENTE_CONSTRUCTORA });
  const lote = [v1, v2, v3];
  const r1 = await pedir('POST', '/sync/push', tokenJuanFer, { ventas: lote });
  const a1 = L.aplicarRespuestaSync(lote, r1.json());
  check('la cola confirma las dos ventas validas, con su numero',
    a1.confirmadas.length === 2 && a1.confirmadas.every((c) => c.numero > 0), r1.body);
  check('la venta a credito queda apartada, no en la cola',
    a1.apartadas.length === 1 && a1.apartadas[0].motivo === 'regla' && a1.quedan.length === 0,
    JSON.stringify(a1));

  const r2 = await pedir('POST', '/sync/push', tokenJuanFer, { ventas: [v1, v2] });
  const a2 = L.aplicarRespuestaSync([v1, v2], r2.json());
  check('reenviar el lote no duplica y devuelve el mismo numero',
    r2.json().ventas.duplicados === 2 && a2.confirmadas.length === 2
    && a2.confirmadas[0].numero === a1.confirmadas[0].numero, r2.body);

  check('lo que el servidor no menciona se queda en la cola',
    L.aplicarRespuestaSync([v1], { ventas: { rechazados: [], asignados: [] } }).quedan.length === 1);

  // Existencias: con 79 no se pueden vender 80 (paso en la prueba con la
  // duenia), y sin existencia no se agrega nada.
  const de79 = L.limitarAExistencia(80, 79, 'Cemento', 'Bolsa');
  check('con 79 en existencia, pedir 80 deja 79 y avisa',
    de79.cantidad === 79 && /Solo hay 79 Bolsa de Cemento/.test(de79.aviso), JSON.stringify(de79));
  check('pedir lo que hay no avisa', L.limitarAExistencia(79, 79).aviso === null);
  check('sin existencia no se agrega', L.limitarAExistencia(1, 0).cantidad === 0
    && L.limitarAExistencia(1, -3).cantidad === 0);
  check('con medidas fraccionarias se limita a lo que hay', L.limitarAExistencia(3, 2.5).cantidad === 2.5);

  const sug = L.sugerenciasDePago(203.5);
  check('los montos sugeridos empiezan por el exacto y no quedan por debajo del total',
    sug[0] === 203.5 && sug.every((m) => m >= 203.5) && sug.includes(500), JSON.stringify(sug));
}

// -----------------------------------------------------------------------------
console.log('\n30. Existencias: con conexion no se vende lo que no hay');
// -----------------------------------------------------------------------------
// En la prueba con la duenia se vendieron 80 de un producto del que habia 79,
// y el stock quedo en negativo. La tablet ya lo frena; aca se comprueba que el
// servidor tambien, para la venta con conexion. La que llega por la cola sin
// conexion se acepta igual: la mercaderia ya se entrego, y rechazarla borraria
// del registro una venta que ocurrio.
{
  const hay = await stockDe(PRODUCTO, TIENDA_FER);
  const linea = (cantidad) => ({ producto_id: PRODUCTO, cantidad, precio_unitario: PRECIO,
                                 costo_unitario: COSTO, descuento: 0,
                                 subtotal: Math.round(cantidad * PRECIO * 100) / 100 });
  const venta = (cantidad) => ({ tienda_id: TIENDA_FER, metodo_pago: 'tarjeta',
                                 subtotal: linea(cantidad).subtotal, descuento: 0,
                                 total: linea(cantidad).subtotal, lineas: [linea(cantidad)] });

  const demas = await pedir('POST', '/ventas', tokenJuanFer, venta(hay + 1));
  check(`vender ${hay + 1} cuando hay ${hay} se rechaza con 409`, demas.statusCode === 409,
    `${demas.statusCode}: ${demas.body}`);
  check('el mensaje dice que producto y cuanto hay',
    demas.statusCode === 409 && new RegExp(`hay ${hay}\\b`).test(demas.json().error)
    && demas.json().faltantes?.[0]?.producto_id === PRODUCTO, demas.body);
  check('y no se toco el stock', await stockDe(PRODUCTO, TIENDA_FER) === hay);

  const justo = await pedir('POST', '/ventas', tokenJuanFer, venta(hay));
  check('vender exactamente lo que hay se permite', justo.statusCode === 201, justo.body);
  check('y el stock queda en cero, no en negativo', await stockDe(PRODUCTO, TIENDA_FER) === 0);

  const sinNada = await pedir('POST', '/ventas', tokenJuanFer, venta(1));
  check('sin existencia no se vende ni uno', sinNada.statusCode === 409, sinNada.body);

  // La cola sin conexion: se acepta y queda registrada aunque deje el stock
  // en negativo. Es la decision documentada, y esta prueba la fija.
  const L = await import('../cliente/logica.js');
  const offline = L.armarVenta({
    carrito: L.agregar([], { id: PRODUCTO, nombre: 'x', precio_venta: PRECIO, precio_costo: COSTO }, 2),
    tienda_id: TIENDA_FER, usuario_id: JUAN,
  });
  const r = await pedir('POST', '/sync/push', tokenJuanFer, { ventas: [offline] });
  check('una venta sin conexion se acepta aunque no haya existencia',
    r.json().ventas?.aceptados === 1, r.body);
  check('y el stock queda en negativo, para que el panel lo muestre',
    await stockDe(PRODUCTO, TIENDA_FER) === -2);
}

// -----------------------------------------------------------------------------
console.log('\n31. Panel del duenio: la pagina, sus calculos y lo que lee de la API');
// -----------------------------------------------------------------------------
// El panel no calcula ventas ni saldos: los lee de los reportes. Lo que se
// prueba aca es (a) que sus funciones de fechas y estados no mientan, y (b) el
// CONTRATO: que cada reporte traiga los campos que el panel usa. Si alguien
// renombra una columna de una vista, el panel mostraria "undefined" o C$0.00
// sin que nada falle; esta seccion lo convierte en una falla.
{
  const pagina = await pedir('GET', '/app/panel.html');
  check('la pagina del panel carga sin sesion', pagina.statusCode === 200 && /panel\.js/.test(pagina.body));
  check('su script se sirve', (await pedir('GET', '/app/panel.js')).statusCode === 200);

  const L = await import('../cliente/logica.js');

  // Fechas del negocio: sin pasar por la zona del navegador.
  check('sumar dias cruza el fin de mes y de anio',
    L.sumarDias('2026-12-25', 13) === '2027-01-07' && L.sumarDias('2026-03-01', -1) === '2026-02-28'
    && L.sumarDias('2028-03-01', -1) === '2028-02-29', L.sumarDias('2026-12-25', 13));
  check('una columna DATE se lee como el dia del calendario, no como el anterior',
    L.diaDe('2026-11-10T00:00:00.000Z') === '2026-11-10');
  check('las horas se muestran en la hora de Nicaragua, no en la del navegador',
    /08:39/.test(L.fechaHora('2026-11-11T02:39:58.000Z')) && /10\/11\/2026/.test(L.fechaHora('2026-11-11T02:39:58.000Z')),
    L.fechaHora('2026-11-11T02:39:58.000Z'));

  const serie = L.serieDiaria([
    { fecha: '2026-11-08T00:00:00.000Z', total_vendido: 100.1 },
    { fecha: '2026-11-08T00:00:00.000Z', total_vendido: 200.2 },   // la otra tienda
    { fecha: '2026-11-10T00:00:00.000Z', total_vendido: 50 },
  ], '2026-11-07', '2026-11-10');
  check('la serie suma las dos tiendas y rellena los dias sin ventas',
    JSON.stringify(serie.map((d) => d.total)) === JSON.stringify([0, 300.3, 0, 50]), JSON.stringify(serie));

  check('sin ventas no hay margen (no "0%")', L.porcentaje(0, 0) === null && L.porcentaje(25, 100) === 25);
  check('caja que cuadra, sobra o falta',
    L.resultadoCaja({ estado: 'cerrada', diferencia_real: 0 }).texto === 'Cuadra'
    && L.resultadoCaja({ estado: 'cerrada', diferencia_real: -3.5 }).clase === 'mal'
    && /Faltan C\$3\.50/.test(L.resultadoCaja({ estado: 'cerrada', diferencia_real: -3.5 }).texto)
    && L.resultadoCaja({ estado: 'abierta', diferencia_real: null }).texto === 'Abierta');
  check('tablet al dia, atrasada o que nunca envio',
    L.estadoSincronizacion(5).clase === 'bien' && L.estadoSincronizacion(90).clase === 'aviso'
    && L.estadoSincronizacion(600).clase === 'mal' && L.estadoSincronizacion(null).texto === 'Nunca envió');
  const inv = [{ producto: 'Cemento Canal', codigo: 'FER-013', cantidad: 5, necesita_reposicion: true },
               { producto: 'Balde', codigo: 'PLA-011', cantidad: -2, necesita_reposicion: true },
               { producto: 'Tubería PVC', codigo: 'FER-022', cantidad: 50, necesita_reposicion: false }];
  check('el inventario se filtra por nombre sin tildes, por codigo, por reponer y por negativo',
    L.filtrarInventario(inv, { buscar: 'tuberia' }).length === 1
    && L.filtrarInventario(inv, { buscar: 'pla-0' }).length === 1
    && L.filtrarInventario(inv, { solo: 'reponer' }).length === 2
    && L.filtrarInventario(inv, { solo: 'negativo' })[0]?.codigo === 'PLA-011');

  // Contrato con la API, con una sesion de administrador nueva (la seccion de
  // cambio de claves cerro las anteriores).
  const admin = await entrarComoAdmin();
  const tiene = (obj, campos) => campos.filter((c) => !(c in (obj ?? {})));

  const tiendas = (await pedir('GET', '/tiendas')).json().tiendas;
  check('las tiendas traen su prefijo (el panel arma "FER-1003" con el)', tiendas.every((t) => t.prefijo));

  const res = (await pedir('GET', '/reportes/resumen', admin)).json();
  check('el resumen dice por que dia agrupo, en formato de fecha', /^\d{4}-\d{2}-\d{2}$/.test(res.fecha), res.fecha);
  check('el resumen trae los totales que muestra el panel',
    tiene(res.consolidado, ['total_vendido', 'ganancia_bruta', 'por_cobrar', 'clientes_con_deuda', 'cantidad_alertas']).length === 0
    && Array.isArray(res.por_tienda) && Array.isArray(res.alertas_stock) && Array.isArray(res.inventario_valorizado));

  const serieApi = (await pedir('GET', `/reportes/ventas?desde=${L.sumarDias(res.fecha, -13)}&hasta=${res.fecha}`, admin)).json().ventas;
  check('la serie diaria trae fecha y total de cada dia',
    serieApi.length > 0 && tiene(serieApi[0], ['fecha', 'tienda_id', 'cantidad_ventas', 'total_vendido', 'ganancia_bruta']).length === 0,
    JSON.stringify(serieApi[0]));

  const ventas = (await pedir('GET', '/ventas', admin)).json();
  check('el listado de ventas trae lo que muestra la tabla y el tamanio de pagina',
    ventas.por_pagina > 0 && tiene(ventas.ventas[0], ['id', 'numero', 'tienda_id', 'tienda', 'vendedor',
      'cliente', 'metodo_pago', 'total', 'anulada', 'ocurrido_en']).length === 0);

  const invApi = (await pedir('GET', '/reportes/inventario', admin)).json().inventario;
  check('el inventario trae lo que muestra la tabla',
    tiene(invApi[0], ['producto_id', 'tienda_id', 'tienda', 'codigo', 'producto', 'cantidad', 'cantidad_minima',
      'precio_costo', 'precio_venta', 'valor_costo', 'valor_venta', 'necesita_reposicion']).length === 0);

  const cobrar = (await pedir('GET', '/reportes/cuentas-por-cobrar?todos=1', admin)).json();
  check('las cuentas por cobrar traen saldo, limite y cupo',
    typeof cobrar.total === 'number' && tiene(cobrar.clientes[0], ['cliente_id', 'nombre', 'saldo', 'limite_credito',
      'cupo_disponible', 'ultima_venta', 'ultimo_abono']).length === 0);
  const cuenta = (await pedir('GET', `/clientes/${cobrar.clientes[0].cliente_id}/estado-cuenta`, admin)).json();
  check('el estado de cuenta trae cliente, ventas fiadas y abonos',
    cuenta.cliente && Array.isArray(cuenta.ventas_fiadas) && Array.isArray(cuenta.abonos));

  const cajas = (await pedir('GET', '/reportes/cuadre-caja', admin)).json().cajas;
  check('el cuadre de caja trae lo esperado, lo contado y la diferencia real',
    cajas.length > 0 && tiene(cajas[0], ['caja_id', 'tienda', 'usuario', 'estado', 'abierta_en', 'cerrada_en',
      'esperado', 'efectivo_contado', 'diferencia_real', 'diferencia_registrada', 'cuadra']).length === 0);

  const tablets = (await pedir('GET', '/sync/estado', admin)).json().dispositivos;
  check('el estado de las tablets trae los minutos sin enviar',
    tiene(tablets[0], ['nombre', 'tienda', 'ultimo_sync', 'minutos_sin_sincronizar']).length === 0);

  // El panel es del administrador: un empleado con sesion no ve los reportes.
  const deEmpleado = await pedir('GET', '/reportes/resumen', tokenJuanFer);
  check('un empleado no puede leer los reportes del panel', deEmpleado.statusCode === 403, `${deEmpleado.statusCode}`);
}

// -----------------------------------------------------------------------------
console.log('\n32. Entradas de mercaderia desde la tablet, por la cola');
// -----------------------------------------------------------------------------
// La tablet registra la mercaderia que llega igual que las ventas: primero en
// su cola, despues por /sync/push. Eso sirve sin senial, pero abre una puerta
// que el camino con conexion tenia cerrada: el AJUSTE (lo unico que puede
// hacer desaparecer mercaderia sin una venta) es solo del administrador en
// POST /inventario/movimientos, y por /sync/push no habia regla.
{
  const L = await import('../cliente/logica.js');
  const juan = await entrarComoEmpleado(JUAN, JUAN_PIN, TIENDA_FER);
  const antes = await stockDe(PRODUCTO, TIENDA_FER);

  // Un ajuste mandado por un empleado por la cola: tiene que rechazarse.
  const ajuste = { uuid_externo: L.nuevoUuid(), tienda_id: TIENDA_FER, producto_id: PRODUCTO,
                   usuario_id: JUAN, tipo: 'ajuste', cantidad: -5, motivo: 'se perdio',
                   ocurrido_en: new Date().toISOString() };
  const rAjuste = (await pedir('POST', '/sync/push', juan, { movimientos: [ajuste] })).json();
  check('un empleado no puede hacer un ajuste por la cola',
    rAjuste.movimientos?.rechazados?.length === 1 && rAjuste.movimientos.aceptados === 0,
    JSON.stringify(rAjuste.movimientos));
  check('y el stock no se movio', await stockDe(PRODUCTO, TIENDA_FER) === antes);

  // El administrador si puede (el mismo criterio que con conexion).
  const admin = await entrarComoAdmin();
  const rAdmin = (await pedir('POST', '/sync/push', admin,
    { movimientos: [{ ...ajuste, uuid_externo: L.nuevoUuid(), cantidad: 1, motivo: 'conteo fisico' }] })).json();
  check('el administrador si puede ajustar por la cola', rAdmin.movimientos?.aceptados === 1,
    JSON.stringify(rAdmin.movimientos));

  // La entrada que arma la tablet: dos productos, con costo y proveedor.
  const { rows: [otro] } = await db.query(
    'SELECT TOP 1 id FROM PRODUCTO WHERE id <> @p AND activo = 1 ORDER BY id', { p: PRODUCTO });
  const lineas = [{ producto_id: PRODUCTO, cantidad: 24, costo_unitario: 12.5 },
                  { producto_id: otro.id, cantidad: 2.5, costo_unitario: 100 }];
  const entrada = L.armarEntrada({ lineas, tienda_id: TIENDA_FER, usuario_id: JUAN,
                                   motivo: 'Factura 0451, Distribuidora Central' });
  const { EsquemaMovimiento } = await import('./validacion.mjs');
  check('la entrada armada por la tablet pasa la validacion del servidor',
    entrada.length === 2 && entrada.every((m) => EsquemaMovimiento.safeParse(m).success),
    JSON.stringify(entrada.map((m) => EsquemaMovimiento.safeParse(m).error?.issues?.[0])));

  const stockAntes = await stockDe(PRODUCTO, TIENDA_FER);
  const r1 = (await pedir('POST', '/sync/push', juan, { movimientos: entrada })).json();
  const a1 = L.aplicarRespuestaMovimientos(entrada, r1);
  check('la entrada entra por la cola y sale de ella',
    r1.movimientos.aceptados === 2 && a1.confirmados.length === 2 && a1.apartados.length === 0,
    JSON.stringify(r1.movimientos));
  check('el stock sube lo que entro', await stockDe(PRODUCTO, TIENDA_FER) === stockAntes + 24);

  const r2 = (await pedir('POST', '/sync/push', juan, { movimientos: entrada })).json();
  check('reenviar la entrada no la duplica', r2.movimientos.duplicados === 2
    && await stockDe(PRODUCTO, TIENDA_FER) === stockAntes + 24, JSON.stringify(r2.movimientos));

  const { rows: [guardado] } = await db.query(
    `SELECT motivo, costo_unitario FROM MOVIMIENTO_INVENTARIO WHERE uuid_externo = @u`,
    { u: entrada[0].uuid_externo });
  check('queda con su costo y con el proveedor como motivo',
    Number(guardado.costo_unitario) === 12.5 && /Distribuidora Central/.test(guardado.motivo), JSON.stringify(guardado));

  // Lo rechazado se aparta y lo que el servidor no menciona... no existe con
  // 200: /sync/push procesa todos los elementos, asi que lo que no esta en
  // rechazados entro o ya estaba.
  const malo = { ...entrada[0], uuid_externo: L.nuevoUuid(), tienda_id: TIENDA_PLA };
  const r3 = (await pedir('POST', '/sync/push', juan, { movimientos: [malo] })).json();
  const a3 = L.aplicarRespuestaMovimientos([malo], r3);
  check('una entrada de otra tienda se aparta con su motivo',
    a3.apartados.length === 1 && a3.apartados[0].motivo === 'permiso', JSON.stringify(r3.movimientos));

  check('la tablet no arma una entrada sin cantidad o con costo negativo',
    L.problemasDeEntrada([{ nombre: 'x', cantidad: 0, costo_unitario: 1 }]).length === 1
    && L.problemasDeEntrada([{ nombre: 'x', cantidad: 1, costo_unitario: -1 }]).length === 1
    && L.problemasDeEntrada([]).length === 1
    && L.problemasDeEntrada([{ nombre: 'x', cantidad: 3, costo_unitario: 0 }]).length === 0);
}

// -----------------------------------------------------------------------------
console.log('\n33. Mermas: lo que se rompe o vence, sin dejar el stock en negativo');
// -----------------------------------------------------------------------------
// Una merma o un ajuste negativo por mas de lo que hay deja el stock en
// negativo: el sistema diria que hay menos que nada. Con conexion se rechaza,
// igual que la venta (seccion 30). Por la cola se acepta, por la misma razon
// que la venta: lo roto ya se rompio, y rechazarlo solo lo borraria del
// registro; el negativo queda a la vista para revisar.
{
  const L = await import('../cliente/logica.js');
  const juan = await entrarComoEmpleado(JUAN, JUAN_PIN, TIENDA_FER);
  const admin = await entrarComoAdmin();
  const { rows: [prod] } = await db.query(
    `SELECT TOP 1 p.id FROM PRODUCTO p JOIN Stock s ON s.producto_id = p.id AND s.tienda_id = @t
      WHERE s.cantidad >= 3 AND p.id <> @p ORDER BY p.id`, { t: TIENDA_FER, p: PRODUCTO });
  const hay = await stockDe(prod.id, TIENDA_FER);
  const merma = (cantidad, motivo = 'se cayo de la estanteria') => ({
    tienda_id: TIENDA_FER, producto_id: prod.id, tipo: 'merma', cantidad: -cantidad, motivo });

  const demas = await pedir('POST', '/inventario/movimientos', juan, merma(hay + 1));
  check(`una merma de ${hay + 1} cuando hay ${hay} se rechaza con 409`, demas.statusCode === 409,
    `${demas.statusCode}: ${demas.body}`);
  check('el mensaje dice cuanto hay', new RegExp(`hay ${hay}\\b`).test(demas.json().error ?? ''), demas.body);
  check('y el stock no se toco', await stockDe(prod.id, TIENDA_FER) === hay);

  const sinMotivo = await pedir('POST', '/inventario/movimientos', juan, merma(1, null));
  check('una merma sin decir que paso se rechaza', sinMotivo.statusCode === 400, sinMotivo.body);

  const justo = await pedir('POST', '/inventario/movimientos', juan, merma(hay));
  check('una merma de todo lo que hay se permite y deja el stock en cero',
    justo.statusCode === 201 && justo.json().stock_resultante === 0, justo.body);

  const sinNada = await pedir('POST', '/inventario/movimientos', juan, merma(1));
  check('sin existencia no se registra merma', sinNada.statusCode === 409, sinNada.body);

  const ajusteDemas = await pedir('POST', '/inventario/movimientos', admin,
    { tienda_id: TIENDA_FER, producto_id: prod.id, tipo: 'ajuste', cantidad: -1, motivo: 'conteo fisico' });
  check('un ajuste negativo tampoco deja el stock bajo cero', ajusteDemas.statusCode === 409, ajusteDemas.body);
  const ajusteArriba = await pedir('POST', '/inventario/movimientos', admin,
    { tienda_id: TIENDA_FER, producto_id: prod.id, tipo: 'ajuste', cantidad: 4, motivo: 'conteo fisico' });
  check('un ajuste positivo se sigue permitiendo', ajusteArriba.statusCode === 201
    && ajusteArriba.json().stock_resultante === 4, ajusteArriba.body);

  // La merma que arma la tablet.
  const lineas = [{ producto_id: prod.id, nombre: 'x', cantidad: 2, costo_unitario: 10, existencia: 4 }];
  const movs = L.armarMerma({ lineas, tienda_id: TIENDA_FER, usuario_id: JUAN, motivo: 'Vencido' });
  const { EsquemaMovimiento } = await import('./validacion.mjs');
  check('la merma armada por la tablet resta y pasa la validacion del servidor',
    movs.length === 1 && movs[0].tipo === 'merma' && movs[0].cantidad === -2
    && EsquemaMovimiento.safeParse(movs[0]).success, JSON.stringify(movs[0]));
  const r = (await pedir('POST', '/sync/push', juan, { movimientos: movs })).json();
  check('entra por la cola y baja el stock', r.movimientos?.aceptados === 1
    && await stockDe(prod.id, TIENDA_FER) === 2, JSON.stringify(r.movimientos));

  // Por la cola se acepta aunque deje el stock en negativo: ya ocurrio.
  const deMas = L.armarMerma({ lineas: [{ ...lineas[0], cantidad: 5 }], tienda_id: TIENDA_FER,
                                usuario_id: JUAN, motivo: 'Roto' });
  const r2 = (await pedir('POST', '/sync/push', juan, { movimientos: deMas })).json();
  check('una merma sin conexion se acepta aunque deje el stock en negativo',
    r2.movimientos?.aceptados === 1 && await stockDe(prod.id, TIENDA_FER) === -3, JSON.stringify(r2.movimientos));

  // Lo que la tablet no deja armar.
  const p = (ls, motivo = 'Roto') => L.problemasDeMerma(ls, motivo);
  check('la tablet no arma una merma mayor a la existencia, sin motivo o vacia',
    p([{ nombre: 'x', cantidad: 5, existencia: 4 }]).length === 1
    && p([{ nombre: 'x', cantidad: 1, existencia: 4 }], '  ').length === 1
    && p([]).length === 1
    && p([{ nombre: 'x', cantidad: 4, existencia: 4 }]).length === 0);
}

// -----------------------------------------------------------------------------
console.log('\n34. Tablets: alta, envios y baja');
// -----------------------------------------------------------------------------
// El panel muestra cuando envio cada tablet por ultima vez. Para que sirva, la
// tablet tiene que poder darse de alta, mandar su id, y ese id tiene que ser
// creible: si cualquiera pudiera marcar como "al dia" la tablet de la otra
// tienda, el aviso de "esta tablet no envia hace horas" no valdria nada.
{
  const juan = await entrarComoEmpleado(JUAN, JUAN_PIN, TIENDA_FER);
  const maria = await entrarComoEmpleado(MARIA, MARIA_PIN, TIENDA_PLA);
  const admin = await entrarComoAdmin();
  const minutosDe = async (id) => {
    const { rows } = await db.query(
      'SELECT DATEDIFF(SECOND, ultimo_sync, SYSUTCDATETIME()) AS s FROM DISPOSITIVO WHERE id = @id', { id });
    return rows[0]?.s;
  };
  const logsDe = async (id) => (await db.query(
    'SELECT COUNT(*) AS n FROM SYNC_LOG WHERE dispositivo_id = @id', { id })).rows[0].n;

  // Alta desde la tablet: la tienda sale de la sesion.
  const alta = await pedir('POST', '/dispositivos', juan, { nombre: 'Tablet mostrador' });
  check('un empleado da de alta su tablet', alta.statusCode === 201
    && alta.json().tienda_id === TIENDA_FER && alta.json().id > 0, alta.body);
  const miTablet = alta.json().id;
  check('no puede darla de alta en la otra tienda',
    (await pedir('POST', '/dispositivos', juan, { nombre: 'x', tienda_id: TIENDA_PLA })).statusCode === 403);
  check('sin nombre no se da de alta',
    (await pedir('POST', '/dispositivos', juan, { nombre: '' })).statusCode === 400);
  check('el administrador tiene que decir de que tienda es',
    (await pedir('POST', '/dispositivos', admin, { nombre: 'x' })).statusCode === 400);
  check('y con la tienda, la da de alta',
    (await pedir('POST', '/dispositivos', admin, { nombre: 'Tablet bodega 2', tienda_id: TIENDA_PLA })).statusCode === 201);

  // Envio vacio: la tablet esta encendida y con senial pero no vendio nada.
  // Tiene que contar como "al dia", sin llenar la bitacora de filas vacias.
  await db.query('UPDATE DISPOSITIVO SET ultimo_sync = DATEADD(HOUR, -3, SYSUTCDATETIME()) WHERE id = @id', { id: miTablet });
  const logsAntes = await logsDe(miTablet);
  const latido = await pedir('POST', '/sync/push', juan, { dispositivo_id: miTablet, ventas: [], movimientos: [] });
  check('un envio sin nada pone la tablet al dia', latido.statusCode === 200 && await minutosDe(miTablet) < 60,
    `${await minutosDe(miTablet)} s`);
  check('pero no deja una fila vacia en la bitacora', await logsDe(miTablet) === logsAntes);

  // El id tiene que ser de una tienda de quien envia.
  const { rows: [dePla] } = await db.query(
    "SELECT id FROM DISPOSITIVO WHERE tienda_id = @t AND nombre = 'Caja Principal - Plastiqueria'", { t: TIENDA_PLA });
  await db.query('UPDATE DISPOSITIVO SET ultimo_sync = DATEADD(HOUR, -3, SYSUTCDATETIME()) WHERE id = @id', { id: dePla.id });
  const ajeno = await pedir('POST', '/sync/push', juan, { dispositivo_id: dePla.id, ventas: [], movimientos: [] });
  check('un empleado no puede poner al dia la tablet de la otra tienda',
    ajeno.statusCode === 200 && await minutosDe(dePla.id) > 3600, `${await minutosDe(dePla.id)} s`);
  await pedir('POST', '/sync/push', maria, { dispositivo_id: dePla.id, ventas: [], movimientos: [] });
  check('la de su tienda si', await minutosDe(dePla.id) < 60);

  // Baja: una tablet perdida deja de contar.
  check('un empleado no puede dar de baja una tablet',
    (await pedir('PATCH', `/dispositivos/${miTablet}`, juan, { activo: false })).statusCode === 403);
  const baja = await pedir('PATCH', `/dispositivos/${miTablet}`, admin, { activo: false });
  check('el administrador da de baja una tablet', baja.statusCode === 200, baja.body);
  const estado = (await pedir('GET', '/sync/estado', admin)).json().dispositivos;
  check('y deja de aparecer en el panel', !estado.some((d) => d.id === miTablet));
  await db.query('UPDATE DISPOSITIVO SET ultimo_sync = DATEADD(HOUR, -3, SYSUTCDATETIME()) WHERE id = @id', { id: miTablet });
  await pedir('POST', '/sync/push', juan, { dispositivo_id: miTablet, ventas: [], movimientos: [] });
  check('los envios de una tablet dada de baja no la ponen al dia', await minutosDe(miTablet) > 3600);

  // El ingreso con el id de una tablet de otra tienda no la ata a la sesion.
  const r = await pedir('POST', '/auth/login/pin', undefined,
    { usuario_id: JUAN, tienda_id: TIENDA_FER, pin: JUAN_PIN, dispositivo_id: dePla.id });
  const { rows: [ses] } = await db.query(
    'SELECT TOP 1 dispositivo_id FROM SESION WHERE usuario_id = @u ORDER BY created_at DESC', { u: JUAN });
  check('el ingreso con una tablet de otra tienda no la registra en la sesion',
    r.statusCode === 200 && ses.dispositivo_id == null, `${r.statusCode} ${JSON.stringify(ses)}`);
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
