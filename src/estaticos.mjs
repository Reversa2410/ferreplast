// =============================================================================
// Archivos del punto de venta (carpeta cliente/), servidos por la misma API.
//
// POR QUE EL MISMO SERVIDOR Y NO UNO APARTE: la tablet habla con un solo
// origen. Con la aplicacion en otro puerto, cada peticion a la API seria de
// origen cruzado, y el service worker -- que es lo que deja abrir la
// aplicacion sin senial -- solo puede guardar lo que es de su propio origen.
//
// No usa @fastify/static: son una docena de archivos, y una dependencia mas
// es una cosa mas que actualizar en una maquina que casi nunca tiene internet.
// =============================================================================

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, extname, sep } from 'node:path';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', 'cliente');

const TIPOS = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json; charset=utf-8',
};

export default async function rutasEstaticas(app) {
  app.get('/', async (_p, respuesta) => respuesta.redirect('/app/'));
  app.get('/app', async (_p, respuesta) => respuesta.redirect('/app/'));

  app.get('/app/*', async (peticion, respuesta) => {
    const pedido = peticion.params['*'] || 'index.html';
    // normalize resuelve los "..": si el resultado sale de la carpeta, alguien
    // esta pidiendo un archivo del servidor por la puerta de la aplicacion.
    const ruta = normalize(join(RAIZ, pedido));
    if (!ruta.startsWith(RAIZ + sep)) return respuesta.code(404).send({ error: 'no encontrado' });

    const tipo = TIPOS[extname(ruta)];
    if (!tipo) return respuesta.code(404).send({ error: 'no encontrado' });

    let contenido;
    try {
      contenido = await readFile(ruta);
    } catch {
      return respuesta.code(404).send({ error: 'no encontrado' });
    }

    // El navegador tiene que preguntar siempre por estos archivos: el service
    // worker es el que decide cuando usar la copia guardada. Si ademas los
    // cacheara el navegador por su cuenta, una version nueva podria tardar
    // dias en llegar a la tablet.
    return respuesta
      .header('content-type', tipo)
      .header('cache-control', 'no-cache')
      .send(contenido);
  });
}
