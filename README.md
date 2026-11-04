# Ferreplast

Sistema de gestión, inventario y supervisión financiera para dos tiendas de un
mismo dueño —una ferretería y una plastiquería— que hoy llevan todo a lápiz y
papel.

Las tiendas trabajan con **conexión intermitente**, así que el sistema está
diseñado para funcionar sin internet en el mostrador y sincronizar solo cuando
vuelve la señal.

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
| Esquema de base de datos (SQL Server) | Listo y verificado (33 pruebas) |
| Datos de prueba | Listos — 100 productos, 2 tiendas |
| Diagrama entidad-relación | Desactualizado — ver [CAMBIOS-MODELO.md](docs/diagramas/CAMBIOS-MODELO.md) |
| API de sincronización y reportes | Escrita, **pendiente de portar** a SQL Server |
| Autenticación y permisos | Escrita, **pendiente de portar** a SQL Server |
| Alta de productos y usuarios | Pendiente |
| Apertura y cierre de caja | Pendiente |
| PWA / punto de venta | Pendiente |
| Panel del administrador | Pendiente |

> El proyecto migró de PostgreSQL a SQL Server. La base ya está migrada y
> verificada; la API todavía usa el driver de PostgreSQL y no corre contra el
> esquema nuevo. La versión anterior quedó archivada en `db/_postgresql/`.

## Estructura

```
ferreplast/
├── db/
│   ├── schema.sql          definición completa de la base (T-SQL)
│   ├── seed.sql            datos de prueba
│   ├── test-esquema.sql    33 pruebas del esquema
│   └── _postgresql/        versión anterior, archivada como referencia
├── src/
│   ├── servidor.mjs        construcción de la aplicación HTTP
│   ├── db.mjs              acceso a datos (PostgreSQL real o PGlite)
│   ├── validacion.mjs      esquemas de validación de lo que llega
│   ├── auth/
│   │   ├── password.mjs    hash de contraseñas y PIN (scrypt)
│   │   ├── sesiones.mjs    crear, verificar y revocar sesiones
│   │   ├── intentos.mjs    límite de intentos fallidos
│   │   └── guardia.mjs     el hook que protege las rutas
│   ├── rutas/
│   │   ├── auth.mjs        ingreso y salida
│   │   ├── sync.mjs        sincronización offline
│   │   └── reportes.mjs    panel del dueño
│   └── test-api.mjs        pruebas de la API
├── docs/
│   ├── SCHEMA.md           decisiones de diseño de la base
│   ├── diagramas/
│   │   ├── CAMBIOS-MODELO.md   qué actualizar en el diagrama y por qué
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

Para cargar el esquema en la base real, copiar `.env.example` como `.env`,
completar `DATABASE_URL` con la cadena de conexión de Neon y ejecutar
`db/schema.sql` seguido de `db/seed.sql`.

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
