// =============================================================================
// Service worker: deja abrir el punto de venta sin senial.
//
// Guarda SOLO los archivos de la aplicacion. Las peticiones a la API pasan de
// largo: una respuesta vieja de /caja/actual o de /sync/catalogo es peor que
// ninguna, porque la pantalla la mostraria como si fuera de ahora. Los datos
// sin conexion los guarda app.js en la tablet, con su fecha.
//
// Al cambiar cualquier archivo de cliente/ hay que subir VERSION: es lo que
// hace que las tablets descarguen la version nueva.
// =============================================================================

const VERSION = 'pv-5';
const ARCHIVOS = [
  './', 'index.html', 'estilos.css', 'app.js', 'logica.js',
  'manifest.webmanifest', 'icono.svg',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(ARCHIVOS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((claves) => Promise.all(claves.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Red primero, copia guardada si no hay red. Asi una version nueva llega en
// cuanto hay senial, y sin senial la aplicacion abre igual.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || !url.pathname.startsWith('/app/')) return;
  e.respondWith(
    fetch(e.request)
      .then((r) => {
        if (r.ok) { const copia = r.clone(); caches.open(VERSION).then((c) => c.put(e.request, copia)); }
        return r;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true })
        .then((r) => r ?? caches.match('index.html'))),
  );
});
