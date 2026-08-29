// =============================================================================
// Capa de acceso a datos
//
// Expone una interfaz minima (query / tx) sobre dos implementaciones distintas:
//
//   * pg      -> PostgreSQL real (Neon) en desarrollo y produccion
//   * PGlite  -> PostgreSQL sobre WebAssembly, en memoria, para las pruebas
//
// Ambos hablan el mismo dialecto y usan parametros $1, $2..., asi que el codigo
// de las rutas no sabe cual de los dos tiene debajo. Eso permite probar la API
// contra un PostgreSQL de verdad sin servidor, sin Docker y sin conexion.
// =============================================================================

/**
 * Adaptador sobre un Pool de `pg` (PostgreSQL real).
 */
export function crearClientePg(connectionString) {
  // Import diferido: si solo se corren las pruebas, no hace falta cargar pg.
  return import('pg').then(({ default: pg }) => {
    const pool = new pg.Pool({
      connectionString,
      // Neon exige TLS. En local sin TLS habria que quitar esto.
      ssl: connectionString.includes('localhost') ? false : { rejectUnauthorized: true },
      max: 10,
    });

    return {
      query: (sql, params) => pool.query(sql, params),

      // Ejecuta fn dentro de una transaccion. Si fn lanza, se revierte todo.
      async tx(fn) {
        const cliente = await pool.connect();
        try {
          await cliente.query('BEGIN');
          const resultado = await fn(cliente);
          await cliente.query('COMMIT');
          return resultado;
        } catch (e) {
          await cliente.query('ROLLBACK');
          throw e;
        } finally {
          cliente.release();
        }
      },

      cerrar: () => pool.end(),
    };
  });
}

/**
 * Adaptador sobre PGlite (para pruebas). Recibe una instancia ya creada.
 */
export function crearClientePglite(pglite) {
  return {
    query: (sql, params) => pglite.query(sql, params),
    tx: (fn) => pglite.transaction(fn),
    cerrar: () => pglite.close(),
  };
}
