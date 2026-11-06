# Ferreplast

Sistema de gestión, inventario y supervisión financiera para dos tiendas de un
mismo dueño —una ferretería y una plastiquería— que hoy llevan todo a lápiz y
papel.

Las tiendas están en un pueblo donde la señal se cae seguido y los apagones
dejan al local sin internet por ratos: no es la excepción, es la condición
normal de trabajo. Por eso el sistema está diseñado para **seguir vendiendo sin
internet** en el mostrador y sincronizar cuando vuelve la señal.

Ese requisito es el que justifica `DISPOSITIVO`, `SYNC_LOG`, los
`uuid_externo` y que el stock se derive de movimientos en vez de guardarse como
un total que se pisa. Sin él, media docena de decisiones del modelo no se
entienden.

---

## Arquitectura

```
┌──────────────────────┐   ┌──────────────────────┐
│  Ferretería          │   │  Plastiquería        │
│  tablet · PWA        │   │  tablet · PWA        │
│  funciona offline    │   │  funciona offline    │
└──────────┬───────────┘   └──────────┬───────────┘
           │      sincroniza al haber señal      │
           └──────────────┬──────────────────────┘
                          ▼
                ┌───────────────────┐
                │  API + SQL Server │
                └─────────┬─────────┘
                          ▼
                ┌───────────────────┐
                │  Panel del dueño  │
                │  ambas tiendas    │
                └───────────────────┘
```

Una sola aplicación con dos perfiles de uso:

- **Empleado** — punto de venta de su tienda: vender, registrar entradas de
  mercadería, cerrar caja.
- **Administrador** — panel web sobre ambas tiendas: ventas, inventario
  valorizado, ganancia real, alertas de reposición, comparativa entre tiendas.

## Estado

| Componente | Estado |
|---|---|
| Esquema de base de datos (SQL Server) | Listo y verificado (52 pruebas, 17 tablas) |
| Datos de prueba | Listos — 100 productos, 2 tiendas, 2 clientes con crédito |
| Diagrama entidad-relación | Al día — ver [DECISIONES-MODELO.md](docs/diagramas/DECISIONES-MODELO.md) |
| API sobre SQL Server | Lista y verificada (247 pruebas, 44 endpoints) |
| Autenticación y permisos | Lista — sesiones, PIN, alcance por tienda, límite de intentos |
| Sincronización offline | Lista — idempotente por `uuid_externo` |
| Crédito a clientes y abonos | Listo — solo con conexión, por diseño |
| Alta de productos y categorías | Lista |
| Alta de usuarios y cambio de claves | Lista |
| Apertura y cierre de caja | Lista — la diferencia la calcula el servidor |
| PWA / punto de venta | Pendiente — es el siguiente paso |
| Panel del administrador | Pendiente |

> El proyecto migró de PostgreSQL a SQL Server. La base y la API ya están
> migradas y verificadas; la versión anterior quedó archivada en
> `db/_postgresql/` como referencia.
>
> **`npm test` corre las dos suites.** `npm run db:test` prueba el esquema
> contra la `FerreplastDB` local (52 pruebas) y `npm run test:api` prueba la
> API (247 pruebas). La segunda es independiente y no puede tocar los datos
> de trabajo: crea `FerreplastPruebaApi`, le aplica el esquema y los datos,
> corre, y la borra.
>
> La conexión usa **autenticación de Windows**, así que no hay ninguna
> credencial que configurar ni guardar: `npm run dev` arranca sin `.env`.

## Estructura

```
ferreplast/
├── db/
│   ├── schema.sql          definición completa de la base (T-SQL)
│   ├── seed.sql            datos de prueba
│   ├── test-esquema.sql    52 pruebas del esquema
│   └── _postgresql/        versión anterior, archivada como referencia
├── src/
│   ├── servidor.mjs        construcción de la aplicación HTTP
│   ├── db.mjs              acceso a datos (SQL Server por ODBC)
│   ├── validacion.mjs      esquemas de validación de lo que llega
│   ├── auth/
│   │   ├── password.mjs    hash de contraseñas y PIN (scrypt)
│   │   ├── sesiones.mjs    crear, verificar y revocar sesiones
│   │   ├── intentos.mjs    límite de intentos fallidos
│   │   └── guardia.mjs     el hook que protege las rutas
│   ├── dominio/
│   │   └── ventas.mjs      registrar y anular ventas (lo usan dos rutas)
│   ├── rutas/
│   │   ├── _ayudas.mjs     validación y traducción de errores de la base
│   │   ├── auth.mjs        ingreso, salida y lista de tiendas
│   │   ├── sync.mjs        sincronización offline
│   │   ├── catalogo.mjs    productos, categorías e inventario
│   │   ├── ventas.mjs      ventas con conexión y anulaciones
│   │   ├── caja.mjs        apertura y cierre de turno
│   │   ├── clientes.mjs    clientes a crédito y abonos
│   │   ├── usuarios.mjs    alta de usuarios y cambio de claves
│   │   └── reportes.mjs    panel del dueño
│   └── test-api.mjs        247 pruebas de la API
├── docs/
│   ├── API.md              contrato de la API (lo que necesita el cliente)
│   ├── SCHEMA.md           decisiones de diseño de la base
│   ├── diagramas/
│   │   ├── DECISIONES-MODELO.md  por qué el modelo es así (defensa)
│   │   └── modelo relacional 2.svg · .png
│   └── word/               documento de presentación
├── .env.example            plantilla de configuración
└── README.md
```

## La API

Todas las rutas exigen una sesión salvo las cuatro marcadas como públicas. El
token va en la cabecera `Authorization: Bearer <token>`.

| Método | Ruta | Quién |
|---|---|---|
| `GET` | `/salud` | pública |
| `GET` | `/auth/empleados/:tiendaId` | pública (lista para la pantalla de ingreso) |
| `POST` | `/auth/login/pin` | pública (empleado) |
| `POST` | `/auth/login/admin` | pública (dueño) |
| `GET` | `/auth/yo` | cualquier sesión |
| `POST` | `/auth/salir` · `/auth/salir/todo` | cualquier sesión |
| `POST` | `/sync/push` | empleado (solo su tienda) · admin |
| `GET` | `/sync/catalogo/:tiendaId` | empleado (solo su tienda) · admin |
| `GET` | `/sync/estado` | admin |
| `GET` | `/reportes/resumen` · `/ventas` · `/inventario` · `/movimientos/:id` | admin |

## Requisitos

- SQL Server 2019 o superior (sirve la edición Developer o Express)
- `sqlcmd` (viene con SQL Server y con SSMS)
- Node.js 20 o superior, para la API

## Puesta en marcha

> **Cuidado:** `db/schema.sql` empieza borrando las tablas (`DROP TABLE IF
> EXISTS`). Recrea `FerreplastDB` desde cero y se lleva lo que hubiera adentro.
> Es lo que se quiere en desarrollo y lo que nunca hay que correr con datos
> reales cargados.

Crear la base, cargar los datos de prueba y verificar que las reglas se
cumplan:

```bash
sqlcmd -S localhost -E -C -f 65001 -i db/schema.sql
```

```bash
sqlcmd -S localhost -E -C -f 65001 -i db/seed.sql
```

```bash
sqlcmd -S localhost -E -C -f 65001 -i db/test-esquema.sql
```

Los tres pasos juntos, si hay Node instalado:

```bash
npm run db:reset
```

Sobre los argumentos: `-E` usa la autenticación de Windows, `-C` acepta el
certificado del servidor local (el driver ODBC 18 lo exige), y `-f 65001` evita
que se rompan las tildes y las eñes.

Las pruebas del esquema **no dejan rastro**: cada una escribe dentro de una
transacción que se revierte. Se pueden correr sobre la base cargada las veces
que haga falta.

Las credenciales de prueba están documentadas en
[`db/seed.sql`](db/seed.sql); son solo para desarrollo local y hay que borrar
esos tres usuarios al cargar datos reales.

Para levantar la API:

```bash
npm install
```

```bash
npm run dev
```

No hace falta `.env`: por defecto apunta a `FerreplastDB` en el SQL Server
local con autenticación de Windows. `DB_SERVIDOR` y `DB_NOMBRE` lo cambian
cuando hace falta, y `.env.example` las documenta.

Para correr las pruebas de la API, que crean y borran su propia base:

```bash
npm run test:api
```

Con `DEBUG_API=1` adelante, además muestra los errores de base que la API le
esconde al cliente a propósito. Es lo que hace falta cuando `/sync/push`
rechaza algo con motivo `base_de_datos`.

## Sobre el diseño de la base

El inventario no se guarda como un número que se suma y se resta, sino como un
registro de movimientos del que el stock se deduce. Es lo que permite que dos
tiendas trabajen sin conexión sin pisarse los datos, y da auditoría completa de
cada cambio.

El razonamiento completo está en [`docs/SCHEMA.md`](docs/SCHEMA.md).

## Stack

| Capa | Tecnología |
|---|---|
| Base de datos | Microsoft SQL Server 2019+ |
| API | Node.js + Fastify |
| Cliente | PWA instalable, con almacenamiento local para trabajar sin conexión |
| Pruebas de base | T-SQL sobre la base real, en transacciones que se revierten |
