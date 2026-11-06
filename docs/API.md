# API de Ferreplast

> Motor: Fastify sobre SQL Server. 44 endpoints, verificados por
> [`src/test-api.mjs`](../src/test-api.mjs) (234 pruebas).
>
> Este documento es el contrato que necesita el cliente. Las razones de cada
> decisión están en los comentarios del código, no acá: lo que sigue es qué
> pedir y qué esperar.

## Lo primero que hay que entender

**Dos caminos escriben ventas, y no son equivalentes.**

| | `POST /sync/push` | `POST /ventas` |
|---|---|---|
| Cuándo | La tablet estuvo sin señal y vacía su cola | Hay conexión |
| Identidad | `uuid_externo` obligatorio | opcional |
| Fecha | `ocurrido_en` obligatorio | la pone el servidor |
| Número de venta | lo asigna el servidor y lo devuelve | igual |
| Crédito | **rechazado** | permitido |
| Respuesta | 200 con el detalle por elemento | 201 con la venta |

Los dos escriben con la misma función, así que el resultado en la base es
idéntico. La diferencia está en qué aceptan.

**El crédito solo entra con conexión.** Es una decisión del modelo, no una
limitación: el límite se comprueba contra el saldo del cliente, y dos tiendas
sin señal no se ven entre sí, así que las dos le fiarían el cupo completo al
mismo cliente. `/sync/push` rechaza esas ventas con `motivo: "regla"`.

## Autenticación

Token opaco en `Authorization: Bearer <token>`. **Toda ruta exige sesión**
salvo cinco: `GET /salud`, `GET /tiendas`, `GET /auth/empleados/:tiendaId`,
`POST /auth/login/pin` y `POST /auth/login/admin`.

El flujo del empleado tiene tres pasos, y el primero es nuevo:

1. `GET /tiendas` → elige en qué local está trabajando
2. `GET /auth/empleados/:tiendaId` → toca su nombre
3. `POST /auth/login/pin` con `{ usuario_id, tienda_id, pin }`

**La tienda se elige al entrar y queda en la sesión.** Un empleado puede estar
asignado a los dos locales; cuál es "su" tienda no es una propiedad de la
persona sino del turno. Ninguna petición posterior manda `tienda_id` para
decidir permisos: el servidor lo lee de la sesión. Lo que un empleado mande
como `tienda_id` en el cuerpo se valida contra su sesión, no la reemplaza.

El administrador no tiene tienda (`tienda_id: null`) y opera sobre las dos; es
el único que puede pasar `tienda_id` como filtro.

Duración: 12 horas para el empleado (cubre un turno sin señal), 2 para el
administrador.

### Códigos

| Código | Significa |
|---|---|
| 400 | el cuerpo no es válido (trae `detalles` campo por campo) |
| 401 | sin sesión, o la sesión no vale |
| 403 | identificado, pero no le corresponde |
| 404 | no existe — **o existe y no es de su tienda** |
| 409 | el estado del negocio no lo admite (pasó el límite, la caja ya está cerrada) |
| 413 | el lote de sincronización pasa de 500 elementos |

El 404 que tapa un 403 es deliberado: a quien no puede ver una venta tampoco se
le confirma que exista.

## Endpoints

### Ingreso

| | Ruta | Quién |
|---|---|---|
| GET | `/salud` | público |
| GET | `/tiendas` | público |
| GET | `/auth/empleados/:tiendaId` | público |
| POST | `/auth/login/pin` | público |
| POST | `/auth/login/admin` | público |
| GET | `/auth/yo` | con sesión |
| POST | `/auth/salir` | con sesión |
| POST | `/auth/salir/todo` | con sesión — para cuando se pierde una tablet |

### Catálogo

| | Ruta | Quién |
|---|---|---|
| GET | `/categorias` | con sesión |
| POST | `/categorias` | administrador |
| GET | `/productos` | con sesión — `?q=` busca por nombre **o código** |
| GET | `/productos/:id` | con sesión — trae el stock de las dos tiendas |
| POST | `/productos` | administrador |
| PATCH | `/productos/:id` | administrador |
| PUT | `/productos/:id/stock-minimo` | administrador — por tienda |
| POST | `/inventario/movimientos` | empleado (entrada, merma) · **solo administrador** para `ajuste` |

**El código de producto es opcional.** La mercadería del negocio no viene con
código, así que exigirlo frenaría la carga del catálogo. Se pueden cargar
muchos productos sin código; los que lo tengan no pueden repetirlo (409).

**No hay DELETE de productos.** Un producto vendido está referenciado por sus
líneas de venta. Se da de baja con `PATCH { "activo": false }`: desaparece del
mostrador y sigue explicando las ventas viejas. `?incluir_inactivos=1` los trae.

**El `ajuste` es solo del administrador** porque es la única operación que puede
hacer desaparecer mercadería sin una venta detrás. Además exige `motivo`.

### Ventas

| | Ruta | Quién |
|---|---|---|
| POST | `/ventas` | empleado en su tienda |
| GET | `/ventas` | empleado ve su tienda; administrador, las dos |
| GET | `/ventas/:id` | ídem, con su detalle |
| POST | `/ventas/:id/anular` | **administrador** — exige `motivo` |
| POST | `/sync/push` | empleado |
| GET | `/sync/catalogo/:tiendaId` | empleado en su tienda |
| GET | `/sync/estado` | administrador |

**La caja la resuelve el servidor.** Si no se manda `caja_id`, usa la que está
abierta en la tienda. Una venta **en efectivo sin caja abierta se rechaza con
409**: no tendría dónde sumar el dinero y el cuadre del turno quedaría corto sin
que nada avise. Con tarjeta o transferencia no hace falta caja.

**Los importes se verifican, no se recalculan en silencio.** El cliente manda
`subtotal`, `descuento` y `total`, y si no coinciden con la aritmética del
servidor la venta se rechaza. Es a propósito: si no coinciden, el ticket que se
le dio al cliente dice algo distinto de lo que se guardaría.

Las reglas de una venta:

- `subtotal` = suma de `cantidad × precio_unitario` de las líneas (bruto)
- `descuento` = suma de los `descuento` de las líneas
- `total` = `subtotal − descuento`
- cada línea: `subtotal` = `cantidad × precio_unitario − descuento`
- un producto no puede repetirse en dos líneas — va en la cantidad
- la rebaja de una línea no puede superar su importe
- `metodo_pago: "credito"` exige `cliente_id`

**Anular no borra.** Marca `anulada`, deja el motivo en `observaciones` y
devuelve la mercadería con movimientos de tipo `devolucion`. Es solo del
administrador porque es exactamente la operación que haría quien se queda con
el efectivo de una venta: anulándola, la caja cuadra igual al cierre.

### Caja

| | Ruta | Quién |
|---|---|---|
| GET | `/caja/actual` | empleado — `{ abierta: false }` si no hay, con 200 |
| POST | `/caja/apertura` | empleado en su tienda |
| POST | `/caja/:id/cierre` | quien la abrió, o el administrador |
| GET | `/caja/:id` | con el detalle de ventas y abonos del turno |

**Una sola caja abierta por tienda.** Abrir una segunda da 409.

**Al cerrar solo se manda `efectivo_contado`**: cuánto había en el cajón. La
diferencia la calcula el servidor contra las ventas en efectivo más los abonos
en efectivo. Si la escribiera el empleado, el número que delata un faltante lo
pondría quien lo tendría.

La respuesta trae `resultado`: `"cuadra"`, `"sobrante"` o `"faltante"`.

### Clientes y crédito

| | Ruta | Quién |
|---|---|---|
| GET | `/clientes` | con sesión — trae el saldo y el cupo |
| POST | `/clientes` | empleado — nace con el límite por omisión (1000 C$) |
| GET | `/clientes/:id/estado-cuenta` | con sesión |
| POST | `/clientes/:id/abonos` | empleado |
| PATCH | `/clientes/:id` | **administrador** — incluye `limite_credito` |

**Crear un cliente lo puede hacer el mostrador; cambiarle el límite, no.**
Anotar nombre y teléfono es trabajo clerical; cuánto se le presta a alguien no
lo decide quien está atendiendo.

**Los abonos son parciales y no se validan contra el saldo.** Pagar de más es un
caso real (un adelanto, un redondeo) y el saldo queda negativo, que significa
saldo a favor. La respuesta trae `saldo_restante`, que es lo que el empleado le
dice al cliente antes de que se vaya.

**El límite lo hace cumplir un trigger de la base, no la API.** Una venta que lo
pase vuelve como 409 con el mensaje del esquema, y **la transacción se revierte
entera**: no queda la venta, ni las líneas, ni el descuento de stock.

Bajar un límite por debajo del saldo actual no se rechaza: el saldo ya existe y
negarlo no lo borra. El cupo queda negativo y no se le puede fiar más.

### Reportes — todos solo del administrador

| | Ruta |
|---|---|
| GET | `/reportes/resumen` — la pantalla principal, las dos tiendas |
| GET | `/reportes/ventas` — serie diaria, `?desde&hasta&tienda_id` |
| GET | `/reportes/inventario` — valorizado a costo y a venta |
| GET | `/reportes/movimientos/:productoId` — la auditoría de un producto |
| GET | `/reportes/cuentas-por-cobrar` — `?todos=1` incluye a los que no deben |
| GET | `/reportes/cuadre-caja` — `?tienda_id&estado` |

Los cálculos viven en las vistas de la base, no en la API: así el mismo número
sale igual desde acá, desde SSMS o desde cualquier herramienta de reportes.

> **Cuidado con la fecha.** `v_ventas_diarias` agrupa por fecha **UTC** y
> Nicaragua es UTC-6, así que las ventas de la tarde se cuentan en el día
> siguiente. Es un pendiente conocido; ver [SCHEMA.md](SCHEMA.md), sección 10.

### Usuarios

| | Ruta | Quién |
|---|---|---|
| POST | `/mi-clave` | con sesión — exige la actual |
| POST | `/mi-pin` | con sesión — exige el actual |
| GET | `/usuarios` | administrador |
| POST | `/usuarios` | administrador |
| PATCH | `/usuarios/:id` | administrador |
| POST | `/usuarios/:id/pin` | administrador — reinicio, no pide el actual |

**Cambiar una clave cierra TODAS las sesiones**, incluida la que hizo el cambio:
si no, quien hubiera entrado con la clave vieja —que es el motivo por el que se
la cambia— seguiría adentro. La respuesta lo avisa con
`debe_volver_a_entrar: true`.

Quitarle una tienda a un empleado, o darlo de baja, también le cierra las
sesiones.

Un administrador necesita `email` + `password`; un empleado, `pin` y al menos
una tienda. **Nunca se devuelve un hash ni la credencial recién creada**: si se
pierde, se reinicia.

## Sincronización: la respuesta de `/sync/push`

Responde **200 aunque haya elementos rechazados**. El lote no fracasa por un
registro malo: de 50 ventas del día, si una viene mal las otras 49 entran igual.

```json
{
  "sincronizado_en": "2026-11-06T14:02:11.000Z",
  "movimientos": { "aceptados": 3, "duplicados": 1, "rechazados": [], "asignados": [] },
  "ventas": {
    "aceptados": 2,
    "duplicados": 0,
    "rechazados": [
      { "uuid_externo": "...", "motivo": "regla",
        "detalles": "el credito necesita conexion: ..." }
    ],
    "asignados": [
      { "uuid_externo": "...", "id": 41, "numero": 1003, "estado": "aceptado" }
    ]
  }
}
```

Qué hace el cliente con esto:

- **`aceptados` y `duplicados`** → borrar de la cola. Un duplicado significa que
  un envío anterior sí llegó.
- **`asignados`** → actualizar el número del comprobante. Lo asigna el servidor,
  así que es la única forma de que el papel coincida con la base.
- **`rechazados`** → apartar, no reintentar. El `motivo` dice qué pasó:

| `motivo` | Qué hacer |
|---|---|
| `validacion` | hay un error en el cliente; `detalles` dice en qué campo |
| `permiso` | esa operación es de otra tienda |
| `regla` | el negocio no lo admite por ese camino (el crédito) |
| `base_de_datos` | no entró; el detalle real está en el log del servidor |

**El `motivo: "base_de_datos"` no explica nada a propósito**: los mensajes de
SQL Server nombran tablas, columnas y restricciones, y eso es un mapa de la base
para quien no debería tenerlo. Para verlo al diagnosticar:
`DEBUG_API=1 npm run test:api`.

## Lo que falta para el punto de venta

La API está completa para lo que el cliente necesita. Lo que queda es del lado
del navegador:

- almacenamiento local del catálogo (`GET /sync/catalogo/:tiendaId`)
- cola de operaciones pendientes, con el `uuid_externo` generado en el
  dispositivo
- reintento al volver la señal, y conciliar los `asignados`
- service worker para que la aplicación cargue sin conexión
