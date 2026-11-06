// =============================================================================
// Capa de acceso a datos (SQL Server)
//
// Expone una interfaz minima -- query / tx / cerrar -- sobre un pool de
// conexiones. Las rutas no conocen el driver: piden db.query(sql, params) y
// reciben { rows, rowCount }.
//
// POR QUE msnodesqlv8 Y NO tedious (el driver puro JavaScript):
// Este servidor esta en modo "solo autenticacion de Windows"
// (SERVERPROPERTY IsIntegratedSecurityOnly = 1). tedious necesita un usuario y
// contrasenia de SQL, que en este servidor no existen; habilitarlos exige
// cambiar la seguridad del servidor y reiniciar el servicio. msnodesqlv8 pasa
// por el driver ODBC y usa la identidad de Windows del proceso, asi que conecta
// sin tocar la configuracion del servidor ni guardar credenciales en ningun
// archivo. Trae binarios precompilados: no hace falta compilar nada.
//
// POR QUE PARAMETROS CON NOMBRE Y NO POSICIONALES:
// Un INSERT de once columnas con VALUES (@1...@11) y un arreglo de once
// elementos es exactamente donde viven los errores de corrimiento: se agrega
// una columna en el medio y los diez valores siguientes entran en la columna
// equivocada, sin que nada falle. Con nombres, ese error no existe.
//
// Los nombres NO pueden ser @p seguido de numero (@p1, @p2...): mssql reserva
// esa forma para los parametros que genera internamente, y el servidor
// responde que la variable ya fue declarada.
// =============================================================================

import sql from 'mssql/msnodesqlv8.js';

// El driver ODBC 18 exige cifrado por defecto, y un SQL Server local presenta
// un certificado autofirmado. TrustServerCertificate lo acepta: la conexion
// sigue cifrada, lo que no se verifica es quien firmo el certificado. Es lo
// razonable contra localhost; contra un servidor remoto habria que instalar un
// certificado de verdad y quitar esa opcion.
const DRIVER_POR_DEFECTO = 'ODBC Driver 18 for SQL Server';

/**
 * Arma la cadena de conexion ODBC.
 *
 * Se construye por partes en lugar de pedir la cadena entera por variable de
 * entorno para que el caso normal (SQL Server local, autenticacion de Windows)
 * no necesite configuracion: alcanza con el nombre de la base.
 */
export function cadenaDeConexion({
  servidor = process.env.DB_SERVIDOR || 'localhost',
  base = process.env.DB_NOMBRE || 'FerreplastDB',
  driver = process.env.DB_DRIVER || DRIVER_POR_DEFECTO,
} = {}) {
  return (
    `Driver={${driver}};Server=${servidor};Database=${base};` +
    'Trusted_Connection=yes;TrustServerCertificate=yes;'
  );
}

// -----------------------------------------------------------------------------
// Normalizacion de resultados
// -----------------------------------------------------------------------------

/**
 * Traduce el resultado de mssql a la forma { rows, rowCount }.
 *
 * rowsAffected es un arreglo con una entrada por sentencia del lote. Interesa
 * la ULTIMA: en un lote como "INSERT ...; UPDATE ..." lo que el llamador
 * pregunta es cuantas filas toco la operacion que pidio, no la suma de los
 * pasos intermedios.
 */
function normalizar(resultado) {
  const filas = resultado.recordset ?? null;
  const afectadas = resultado.rowsAffected ?? [];

  return {
    rows: filas ?? [],
    // Un SELECT no reporta filas afectadas, asi que para las consultas el
    // conteo sale del propio conjunto devuelto.
    rowCount: filas ? filas.length : (afectadas.at(-1) ?? 0),
    // Para los pocos casos que devuelven varios conjuntos en un solo lote.
    recordsets: resultado.recordsets ?? [],
  };
}

/**
 * Carga los parametros en una peticion de mssql.
 *
 * undefined se convierte en null: una propiedad ausente en un objeto de
 * JavaScript y un NULL de SQL significan lo mismo aca, y mssql rechaza
 * undefined con un error que no dice cual parametro fue.
 */
function conParametros(peticion, params) {
  for (const [nombre, valor] of Object.entries(params ?? {})) {
    peticion.input(nombre, valor === undefined ? null : valor);
  }
  return peticion;
}

// -----------------------------------------------------------------------------
// Errores
//
// Las rutas necesitan distinguir "el cliente mando algo que no corresponde" de
// "la base se cayo". Lo primero es un 4xx; lo segundo, un 500. Estas ayudas
// traducen los codigos de SQL Server para no repartir numeros magicos por las
// rutas.
// -----------------------------------------------------------------------------

const DUPLICADO = new Set([2601, 2627]);   // indice unico / clave primaria
const INTEGRIDAD = 547;                    // clave foranea o restriccion CHECK

// Primer numero que el esquema reserva para sus propias reglas (THROW 50001...).
const REGLA_DE_NEGOCIO_DESDE = 50000;

/** El numero de error, este donde este segun el driver. */
function numeroDeError(e) {
  return e?.number ?? e?.originalError?.info?.number ?? null;
}

/** Violacion de una clave unica: la fila ya existe. */
export function esDuplicado(e) {
  return DUPLICADO.has(numeroDeError(e));
}

/** Violacion de clave foranea o de un CHECK: el dato no es admisible. */
export function esIntegridad(e) {
  return numeroDeError(e) === INTEGRIDAD;
}

/**
 * Regla de negocio lanzada por un trigger del esquema (THROW 50001, 50002...).
 *
 * El mensaje de estos errores lo escribimos nosotros en db/schema.sql y esta
 * redactado para que lo lea una persona, asi que es el unico caso en que el
 * texto que viene de la base se le puede devolver al cliente. Los demas
 * nombran tablas, columnas y restricciones, y eso es un mapa de la base para
 * quien no deberia tenerlo.
 */
export function reglaDeNegocio(e) {
  const numero = numeroDeError(e);
  if (numero === null || numero < REGLA_DE_NEGOCIO_DESDE) return null;
  return { numero, mensaje: e.message };
}

// -----------------------------------------------------------------------------
// Cliente
// -----------------------------------------------------------------------------

/**
 * Abre un pool contra SQL Server y devuelve el cliente que usan las rutas.
 *
 * El pool se abre una sola vez al arrancar: abrir una conexion por peticion
 * costaria mas que la consulta.
 */
export async function crearClienteSqlServer(opciones = {}) {
  const pool = new sql.ConnectionPool({
    connectionString: opciones.connectionString ?? cadenaDeConexion(opciones),
    connectionTimeout: 15_000,
    requestTimeout: 30_000,
    pool: { max: 10, min: 0, idleTimeoutMillis: 30_000 },
  });

  await pool.connect();

  return {
    async query(texto, params) {
      return normalizar(await conParametros(pool.request(), params).query(texto));
    },

    /**
     * Ejecuta fn dentro de una transaccion. Si fn lanza, se revierte todo.
     *
     * El rollback va en su propio try: cuando el error viene de un THROW de un
     * trigger, SQL Server ya aborto la transaccion por su cuenta y el rollback
     * falla con "no hay transaccion activa". Ese fallo no debe tapar el error
     * original, que es el que explica lo que paso.
     */
    async tx(fn) {
      const transaccion = new sql.Transaction(pool);
      await transaccion.begin();

      const alcance = {
        async query(texto, params) {
          const peticion = conParametros(new sql.Request(transaccion), params);
          return normalizar(await peticion.query(texto));
        },
      };

      try {
        const resultado = await fn(alcance);
        await transaccion.commit();
        return resultado;
      } catch (e) {
        try { await transaccion.rollback(); } catch { /* ya estaba abortada */ }
        throw e;
      }
    },

    cerrar: () => pool.close(),
  };
}
