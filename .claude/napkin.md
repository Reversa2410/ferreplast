# Napkin Runbook

## Curation Rules
- Re-prioritize on every read.
- Keep recurring, high-value notes only.
- Max 10 items per category.
- Each item includes date + "Do instead".

## Execution & Validation (Highest Priority)
1. **[2026-11-05] `npm test` prueba el ESQUEMA contra SQL Server, no la API**
   Es `sqlcmd -i db/test-esquema.sql` (46 pruebas). Necesita la instancia
   local; NO es PGlite y no prueba nada de `src/`.
   Do instead: validar cualquier cambio de esquema con `npm test`. Para no
   tocar las bases del usuario, copiar los .sql cambiando `FerreplastDB` por
   otro nombre y correrlos sobre esa copia.
2. **[2026-11-03] `crearApp({ db })` recibe la base por parametro**
   Do instead: para probar una ruta nueva, pasarle el cliente PGlite; nunca
   crear la conexion dentro de las rutas.
3. **[2026-11-05] `npm run test:api` esta ROTO desde la migracion a SQL Server**
   `src/test-api.mjs` carga `db/schema.sql` (T-SQL) dentro de PGlite
   (PostgreSQL) y revienta en la primera sentencia (`IF DB_ID(...)`). Todo
   `src/` sigue escrito para PostgreSQL.
   Do instead: no editar `src/` esperando poder verificarlo; los cambios de
   modelo que lo afecten van junto con el porte de la API.
4. **[2026-11-03] Las vistas `v_*` son la fuente de los reportes**
   Do instead: al cambiar un calculo del panel, editar la vista en
   `db/schema.sql`, no la consulta en `src/rutas/reportes.mjs`.
5. **[2026-11-03] Los SVG de `docs/diagramas/` se generan, no se editan**
   Do instead: tocar `_fuente-maestro.svgsrc` o `_fuente-figuras.html` y
   correr `npm run diagramas` (genera + verifica geometria).
6. **[2026-11-03] `npm run diagramas` ROTO: faltan las figuras 01-07**
   `_fuente-figuras.html` quedo con solo 2 SVG (proceso-venta y el maestro), y
   el generador espera 7 figuras. Falla ANTES de escribir, asi que no daña los
   archivos existentes, que siguen pasando `_verificar.mjs`.
   Do instead: para regenerar solo 00 y 08 no hace falta el HTML; para
   recuperar 01-07 hay que reponer sus fuentes en `_fuente-figuras.html`.
7. **[2026-11-03] Toda ruta nueva nace CERRADA**
   Do instead: si debe ser publica, agregarla a `RUTAS_PUBLICAS` en
   `src/auth/guardia.mjs` con el patron de Fastify (`'GET /ruta/:param'`),
   no con la URL concreta.

## Shell & Command Reliability
1. **[2026-11-03] Hay un SQL Server local y se puede probar de verdad**
   Instancia `MSSQLSERVER` (default) corriendo; `sqlcmd` en el PATH.
   Do instead: `sqlcmd -S localhost -E -C -f 65001 -i script.sql`. El `-C` es
   obligatorio (ODBC 18 rechaza el certificado sin el) y `-f 65001` evita que
   se rompan las tildes. Bases del usuario: `Ferreplast`, `FerreplastDB`.
   NUNCA correr sobre ellas un script con DROP: copiarlo y renombrar la base.
2. **[2026-11-03] `git` esta instalado pero puede faltar en el PATH de la sesion**
   Vive en `C:\Program Files\Git\cmd`. Si la sesion arranco antes de instalarlo,
   hereda el PATH viejo y `git` "no se reconoce" aunque este en el PATH del
   sistema. El estado del shell no persiste entre llamadas.
   Do instead: empezar cada comando con
   `$env:Path += ';C:\Program Files\Git\cmd'`.
   La identidad ya esta configurada en el repo (`Reversa2410`): no tocar
   `--global`.
3. **[2026-11-03] El sandbox rechaza here-strings largos junto al PATH**
   Un `git commit -m @'...'@` extenso en el mismo comando que
   `$env:Path += ...` se malinterpreta y se bloquea.
   Do instead: escribir el mensaje a un archivo y usar `git commit -F archivo`.
4. **[2026-11-03] PowerShell 5.1: sin `&&`, sin `??`, sin ternario**
   Do instead: encadenar con `;` o `if ($?) { ... }`.
5. **[2026-11-03] Los PDF de `docs/diagramas/` usan fuentes CID**
   Do instead: no extraer su texto con regex sobre los streams; abrirlos en el
   panel del navegador (`file:///...`) y mirar la captura.

## SQL Server (T-SQL)
1. **[2026-11-03] Un error de sintaxis mata el LOTE entero, no la sentencia**
   SQL Server compila todo el lote antes de ejecutar nada. Sin `GO`, un error
   al final del archivo impide que se cree la primera tabla.
   Do instead: separar secciones con `GO`. Al diagnosticar "no se creo nada",
   buscar el error al FINAL del archivo, no al principio.
2. **[2026-11-03] `SET QUOTED_IDENTIFIER ON` es obligatorio para indices filtrados**
   SSMS lo pone solo; sqlcmd NO. El mismo script funciona con F5 y falla por
   linea de comandos con "CREATE INDEX failed ... SET options".
   Do instead: declararlo al principio del script, no confiar en el cliente.
3. **[2026-11-03] Los triggers se disparan por SENTENCIA, no por fila**
   `inserted` trae TODAS las filas. Un trigger escrito para una sola pierde
   datos en silencio cuando llega un lote de sincronizacion.
   Do instead: agrupar `inserted` con GROUP BY y aplicar por conjuntos.
4. **[2026-11-03] Un indice filtrado no puede comparar dos columnas**
   `WHERE cantidad <= cantidad_minima` falla con "Incorrect WHERE clause".
   Do instead: columna calculada PERSISTED con la comparacion, e indexarla.
5. **[2026-11-03] `DBCC CHECKIDENT RESEED 0` sobre tabla que nunca tuvo filas da id 0**
   Rompe todas las FK que apuntan al 1.
   Do instead: reiniciar solo si `sys.identity_columns.last_value IS NOT NULL`.
6. **[2026-11-03] TRY/CATCH no atrapa errores de COMPILACION**
   Escribir una columna calculada, nombrar una columna inexistente, etc.
   revientan el lote antes de ejecutarlo.
   Do instead: envolver esa sentencia en `sp_executesql` para que el error
   ocurra en ejecucion y se pueda capturar.
7. **[2026-11-05] Hay conector MCP de Lucid: el diagrama se crea desde aca**
   `lucid_create_erd` arma un ERD real y editable desde entidades y FK. NO
   existe forma de reemplazar el contenido de un documento ya creado: solo
   crear uno nuevo (`lucid_update_document` solo cambia titulo, carpeta y
   etiquetas).
   Do instead: para rehacer el modelo, crear documento nuevo y dejar el viejo
   como historial. Las razones de cada decision van en
   `docs/diagramas/DECISIONES-MODELO.md`.

## Domain Behavior Guardrails
1. **[2026-11-03] El stock se deduce de `movimientos_inventario`, no se escribe**
   Do instead: para cambiar stock, insertar un movimiento con signo. La tabla
   `stock` es cache que mantiene un trigger; si se desalinea, `fn_recalcular_stock()`.
2. **[2026-11-03] El historial de movimientos es inmutable (trigger)**
   Do instead: para corregir un error, insertar un `ajuste` compensatorio.
   `UPDATE`/`DELETE` sobre esa tabla fallan a proposito.
3. **[2026-11-03] Los UUID de ventas y movimientos los genera el dispositivo**
   Do instead: insertar siempre con `ON CONFLICT (id) DO NOTHING`. Nunca poner
   `DEFAULT gen_random_uuid()` en esas dos tablas: rompe la idempotencia.
4. **[2026-11-03] Los movimientos de venta los deriva el servidor**
   Do instead: nunca aceptar movimientos de tipo `venta` desde el cliente; se
   generan en `insertarVenta()` a partir de las lineas.
5. **[2026-11-03] NUMERIC llega a JS como texto, no como numero**
   Do instead: envolver con `Number()` antes de sumar importes que vengan de
   PostgreSQL, como ya se hace en `/reportes/resumen`.
6. **[2026-11-03] Agregar ventas con sus lineas causa fan-out**
   Do instead: agregar las lineas en un CTE previo (una fila por venta) y
   recien ahi unir con la cabecera. Ya mordio una vez: ganancia inflada de 60 a 185.

## User Directives
1. **[2026-11-03] Todo el proyecto esta en espaniol, sin tildes en el codigo**
   Do instead: nombres de tablas, rutas, variables, funciones y comentarios en
   espaniol. Codigo y comentarios sin tildes; la documentacion `.md` si las lleva.
2. **[2026-11-03] Los comentarios explican POR QUE, no QUE**
   Do instead: al escribir codigo nuevo, documentar la decision y el escenario
   que la motiva (como en `sync.mjs` y `SCHEMA.md`), no parafrasear la linea.
3. **[2026-11-03] Los pendientes se dejan escritos en el codigo**
   Do instead: marcar lo que falta con un bloque `PENDIENTE` explicito que
   liste los puntos concretos, como el de autenticacion en `servidor.mjs`.
