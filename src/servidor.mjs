// =============================================================================
// Servidor HTTP
//
// crearApp() recibe el cliente de base de datos por parametro en lugar de
// crearlo adentro. Eso es lo que permite que las pruebas le pasen PGlite y que
// en produccion reciba una conexion a Neon, sin cambiar una linea de las rutas.
// =============================================================================

import Fastify from 'fastify';
import cors from '@fastify/cors';
import rutasSync from './rutas/sync.mjs';
import rutasReportes from './rutas/reportes.mjs';

// -----------------------------------------------------------------------------
// PENDIENTE -- AUTENTICACION
//
// Ninguna ruta esta protegida todavia. Cualquiera que llegue al servidor puede
// leer los reportes y escribir movimientos.
//
// Es aceptable mientras corre solo en la maquina de desarrollo, y NO se puede
// desplegar asi. Falta:
//   * login por PIN (empleado) y por email + contrasenia (admin)
//   * token de sesion firmado, verificado en cada peticion
//   * que un empleado solo pueda operar sobre SU tienda
//   * limite de intentos fallidos (un PIN de 4 digitos son 10.000 combinaciones)
// -----------------------------------------------------------------------------

export async function crearApp({ db, logger = false }) {
  const app = Fastify({ logger });

  await app.register(cors, { origin: true });

  // Deja el cliente de base disponible para el resto de la aplicacion.
  app.decorate('db', db);

  app.get('/salud', async () => {
    const { rows } = await db.query('SELECT 1 AS ok');
    return { estado: 'ok', base_de_datos: rows[0].ok === 1 ? 'conectada' : 'error' };
  });

  await app.register(rutasSync, { db });
  await app.register(rutasReportes, { db });

  // Manejador de errores: registra el detalle en el servidor pero no se lo
  // devuelve al cliente, para no filtrar la estructura interna de la base.
  app.setErrorHandler((error, peticion, respuesta) => {
    peticion.log.error({ err: error }, 'error no controlado');
    const codigo = error.statusCode ?? 500;
    respuesta.code(codigo).send({
      error: codigo === 500 ? 'error interno del servidor' : error.message,
    });
  });

  return app;
}

// -----------------------------------------------------------------------------
// Arranque real (solo si se ejecuta este archivo directamente)
// -----------------------------------------------------------------------------
if (process.argv[1]?.endsWith('servidor.mjs')) {
  const { crearClientePg } = await import('./db.mjs');

  if (!process.env.DATABASE_URL) {
    console.error('Falta DATABASE_URL. Copie .env.example como .env y complete la cadena de conexion.');
    process.exit(1);
  }

  const db = await crearClientePg(process.env.DATABASE_URL);
  const app = await crearApp({ db, logger: true });
  const puerto = Number(process.env.PORT) || 3001;

  await app.listen({ port: puerto, host: '0.0.0.0' });
  console.log(`API escuchando en http://localhost:${puerto}`);
}
