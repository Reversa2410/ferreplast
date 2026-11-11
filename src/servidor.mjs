// =============================================================================
// Servidor HTTP
//
// crearApp() recibe el cliente de base de datos por parametro en lugar de
// crearlo adentro. Eso es lo que permite que las pruebas apunten a una base de
// prueba descartable y que en produccion apunte a FerreplastDB, sin cambiar una
// linea de las rutas.
// =============================================================================

import Fastify from 'fastify';
import cors from '@fastify/cors';
import rutasAuth from './rutas/auth.mjs';
import rutasSync from './rutas/sync.mjs';
import rutasReportes from './rutas/reportes.mjs';
import rutasCatalogo from './rutas/catalogo.mjs';
import rutasVentas from './rutas/ventas.mjs';
import rutasCaja from './rutas/caja.mjs';
import rutasClientes from './rutas/clientes.mjs';
import rutasUsuarios from './rutas/usuarios.mjs';
import rutasEstaticas from './estaticos.mjs';
import { registrarGuardia } from './auth/guardia.mjs';

// -----------------------------------------------------------------------------
// AUTENTICACION
//
// Toda ruta exige sesion salvo las cinco de la lista en auth/guardia.mjs
// (salud, lista de tiendas, lista de empleados de una tienda y las dos de
// ingreso).
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
  await app.register(rutasCatalogo, { db });
  await app.register(rutasVentas, { db });
  await app.register(rutasCaja, { db });
  await app.register(rutasClientes, { db });
  await app.register(rutasUsuarios, { db });
  // El punto de venta: la pagina, sus scripts y el service worker.
  await app.register(rutasEstaticas);

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
  const { crearClienteSqlServer } = await import('./db.mjs');

  // No se exige ninguna variable de entorno: por defecto apunta a FerreplastDB
  // en el SQL Server local con autenticacion de Windows, que es el caso de
  // desarrollo. DB_SERVIDOR y DB_NOMBRE lo cambian cuando hace falta.
  let db;
  try {
    db = await crearClienteSqlServer();
  } catch (e) {
    console.error('No se pudo conectar a SQL Server:', e.message);
    console.error('Revise que el servicio este corriendo y que exista la base '
      + `${process.env.DB_NOMBRE || 'FerreplastDB'} (npm run db:crear).`);
    process.exit(1);
  }

  const app = await crearApp({ db, logger: true });
  const puerto = Number(process.env.PORT) || 3001;

  await app.listen({ port: puerto, host: '0.0.0.0' });
  console.log(`API escuchando en http://localhost:${puerto}`);
}
