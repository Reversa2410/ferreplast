// =============================================================================
// Servidor HTTP
//
// crearApp() recibe el cliente de base de datos por parametro en lugar de
// crearlo adentro. Eso es lo que permite que las pruebas le pasen PGlite y que
// en produccion reciba una conexion a Neon, sin cambiar una linea de las rutas.
// =============================================================================

import Fastify from 'fastify';
import cors from '@fastify/cors';
import rutasAuth from './rutas/auth.mjs';
import rutasSync from './rutas/sync.mjs';
import rutasReportes from './rutas/reportes.mjs';
import { registrarGuardia } from './auth/guardia.mjs';

// -----------------------------------------------------------------------------
// AUTENTICACION
//
// Toda ruta exige sesion salvo las cuatro de la lista en auth/guardia.mjs
// (salud, lista de empleados de una tienda y las dos de ingreso).
//
// El guardia se registra ANTES que las rutas a proposito: un hook de Fastify
// solo alcanza a lo que se registra despues de el dentro del mismo ambito. Si
// se invirtiera el orden, las rutas quedarian abiertas sin que nada falle.
// -----------------------------------------------------------------------------

export async function crearApp({ db, logger = false }) {
  const app = Fastify({ logger });

  // origin: true devuelve el origen que pide el navegador, lo que equivale a
  // permitir cualquiera. Sirve mientras el cliente corre en localhost; al
  // desplegar hay que poner aca la lista concreta de origenes permitidos.
  await app.register(cors, { origin: true });

  // Deja el cliente de base disponible para el resto de la aplicacion.
  app.decorate('db', db);

  registrarGuardia(app, db);

  app.get('/salud', async () => {
    const { rows } = await db.query('SELECT 1 AS ok');
    return { estado: 'ok', base_de_datos: rows[0].ok === 1 ? 'conectada' : 'error' };
  });

  await app.register(rutasAuth, { db });
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
