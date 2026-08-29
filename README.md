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
                │  API + PostgreSQL │
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
| Esquema de base de datos | Listo y verificado (28 pruebas) |
| Datos de prueba | Listos |
| API | Pendiente |
| PWA / punto de venta | Pendiente |
| Panel del administrador | Pendiente |

## Estructura

```
ferreplast/
├── db/
│   ├── schema.sql          definición completa de la base
│   ├── seed.sql            datos de prueba
│   └── test-esquema.mjs    pruebas del esquema
├── docs/
│   └── SCHEMA.md           decisiones de diseño de la base
├── .env.example            plantilla de configuración
└── README.md
```

## Requisitos

- Node.js 20 o superior
- Acceso a una base PostgreSQL 15+ (se usa [Neon](https://neon.tech), sin
  instalación local)

## Puesta en marcha

```bash
npm install
```

Las pruebas del esquema **no necesitan base de datos ni conexión**: usan PGlite,
que es PostgreSQL compilado a WebAssembly y corre dentro de Node.

```bash
npm run db:test
```

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
| Base de datos | PostgreSQL 15+ (Neon) |
| API | Node.js |
| Cliente | PWA instalable, con almacenamiento local para trabajar sin conexión |
| Pruebas de base | PGlite (PostgreSQL sobre WebAssembly) |
