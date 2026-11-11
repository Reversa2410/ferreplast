# Napkin Runbook

## Curation Rules
- Re-prioritize on every read.
- Keep recurring, high-value notes only.
- Max 10 items per category.
- Each item includes date + "Do instead".

## Execution & Validation (Highest Priority)
1. **[2026-11-10] `npm test` corre DOS suites: esquema (52) y API (335)**
   `npm run db:test` es `sqlcmd -i db/test-esquema.sql` contra la `FerreplastDB`
   del usuario (tiene que estar sembrada). `npm run test:api` es independiente:
   crea `FerreplastPruebaApi`, le aplica schema+seed, corre y la borra.
   Do instead: tras cambiar `src/`, `npm run test:api`. Tras cambiar
   `db/*.sql`, las dos.
2. **[2026-11-06] `test:api` esconde los errores de la base a proposito**
   Cuando `/sync/push` rechaza algo con motivo `base_de_datos`, el mensaje real
   solo existe en el log del servidor, que en las pruebas esta apagado.
   Do instead: `DEBUG_API=1 node src/test-api.mjs` para verlo.
3. **[2026-11-06] `crearApp({ db })` recibe la base por parametro**
   Do instead: para probar una ruta nueva, pasarle un cliente apuntado a una
   base descartable; nunca crear la conexion dentro de las rutas.
4. **[2026-11-06] Las pruebas de la API nunca pueden tocar las bases reales**
   `src/test-api.mjs` copia los .sql al temporal reemplazando `FerreplastDB`
   por `FerreplastPruebaApi`, y verifica con `DB_NAME()` antes de empezar.
   Do instead: mantener esa comprobacion al agregar pruebas. `schema.sql`
   empieza con DROP TABLE: apuntar a la base de trabajo la borraria.
5. **[2026-11-03] Las vistas `v_*` son la fuente de los reportes**
   Do instead: al cambiar un calculo del panel, editar la vista en
   `db/schema.sql`, no la consulta en `src/rutas/reportes.mjs`.
6. **[2026-11-03] Toda ruta nueva nace CERRADA**
   Do instead: si debe ser publica, agregarla a `RUTAS_PUBLICAS` en
   `src/auth/guardia.mjs` con el patron de Fastify (`'GET /ruta/:param'`),
   no con la URL concreta.
7. **[2026-11-10] Los SVG de `docs/diagramas/` se generan desde `_figuras.mjs`**
   El modelo (atributos y una relacion por FK) vive en `ATR` y `REL`; los
   conectores los calcula un A* en `_dibujo.mjs`. El Word toma de ahi las
   cifras (17 entidades, 30 relaciones) y su tabla de trazabilidad falla si
   falta una entidad. El generador compara `ATR`/`REL` con lo que
   `_esquema.mjs` lee de `db/schema.sql` y aborta si difieren; el relacional
   (`10`) y el anexo del Word se leen directo del esquema. Ojo: el lector
   depende del formato (una columna por linea, 4 espacios, nombre en
   minusculas) y falla si una tabla queda sin columnas o sin PK.
   Do instead: al cambiar una tabla, editar `ATR`/`REL`, correr
   `npm run diagramas` y despues `npm run word`. Si una vista no cierra,
   `DIAGRAMAS_BORRADOR=1` la escribe igual para ver donde mover cajas.
8. **[2026-11-10] resvg ignora `orient="auto-start-reverse"`**
   Deja todas las flechas apuntando a la derecha; las que llegan desde arriba
   quedan tapadas por la caja. Afecta al Word, que rasteriza con resvg.
   Do instead: `orient="auto"` (el verificador lo exige).
9. **[2026-11-10] Las cifras del Word estan en `CIFRAS` de `construir.mjs`**
   Pruebas (52 + 335) y endpoints (46) estan escritos a mano ahi.
   Do instead: al agregar pruebas o rutas, actualizar `CIFRAS` y regenerar.
10. **[2026-11-10] Probar el punto de venta contra `FerreplastPV`, no `FerreplastDB`**
   `.claude/launch.json` levanta la API con `DB_NOMBRE=FerreplastPV` en el 3001;
   vender a mano escribe ventas reales en la base que se apunte. Se crea con
   schema+seed reemplazando el nombre (como hace test-api.mjs). Para probar
   sin senial: `preview_stop`, vender, `preview_start`: la cola se envia sola.
   Do instead: tras cambiar `cliente/`, subir `VERSION` en `cliente/sw.js` si
   ya hay tablets usandolo, o seguiran con la copia vieja.

## Shell & Command Reliability
1. **[2026-11-03] Hay un SQL Server local y se puede probar de verdad**
   Instancia `MSSQLSERVER` (default) corriendo; `sqlcmd` en el PATH.
   Do instead: `sqlcmd -S localhost -E -C -f 65001 -i script.sql`. El `-C` es
   obligatorio (ODBC 18 rechaza el certificado sin el) y `-f 65001` evita que
   se rompan las tildes. Bases del usuario: `Ferreplast`, `FerreplastDB`.
   NUNCA correr sobre ellas un script con DROP: copiarlo y renombrar la base.
2. **[2026-11-06] `sqlcmd -i` rechaza rutas absolutas con barra normal**
   `-i "C:/carpeta/x.sql"` falla con "The -E and the -U/-P options are
   mutually exclusive": parsea `/carpeta` como opcion. Desconcierta porque el
   error no menciona la ruta.
   Do instead: barras invertidas (`C:\carpeta\x.sql`) o ruta relativa. Desde
   Node, `path.join` ya las produce.
3. **[2026-11-03] `git` esta instalado pero puede faltar en el PATH de la sesion**
   Vive en `C:\Program Files\Git\cmd`. Si la sesion arranco antes de instalarlo,
   hereda el PATH viejo y `git` "no se reconoce" aunque este en el PATH del
   sistema. El estado del shell no persiste entre llamadas.
   Do instead: empezar cada comando con
   `$env:Path += ';C:\Program Files\Git\cmd'`.
   La identidad ya esta configurada en el repo (`Reversa2410`): no tocar
   `--global`.
4. **[2026-11-06] `CREATE VIEW` / `CREATE FUNCTION` tiene que ser la UNICA
   sentencia de su lote**
   Un `-Q "SET QUOTED_IDENTIFIER ON; CREATE OR ALTER VIEW ..."` NO crea la
   vista, y sqlcmd puede devolver 0 igual: el cambio se da por hecho y no
   ocurrio. Costo una conclusion equivocada ("la prueba no detecta el error",
   cuando lo que no se habia aplicado era el error).
   Do instead: los SET van en su propio lote separado por `GO`, o sea en un
   archivo con `-i`, no en un `-Q`. Despues confirmar con
   `OBJECT_DEFINITION(OBJECT_ID('...')) LIKE '%...%'`.
5. **[2026-11-06] Una prueba de regresion no vale hasta verla FALLAR**
   Escribir la prueba despues del arreglo y verla pasar no demuestra nada.
   Do instead: deshacer el arreglo en una base descartable, confirmar que la
   prueba falla con el detalle esperado, y recien entonces restaurar. Para
   tocar un archivo del repo en el medio, copiarlo al scratchpad primero
   (`git checkout --` se llevaria los cambios sin commitear).
6. **[2026-11-06] Los here-doc largos de bash fallan en esta sesion**
   Un `cat > archivo <<'EOF'` con un archivo de codigo entero corta con
   "unexpected EOF while looking for matching quote". Pasa tambien con los
   here-strings de PowerShell junto al PATH.
   Do instead: escribir archivos con la herramienta Write. Para mensajes de
   commit, `git commit -F archivo`.
7. **[2026-11-06] No hay `pkill` ni Python en esta maquina**
   Do instead: para matar un proceso por puerto,
   `Get-NetTCPConnection -LocalPort N -State Listen` y `Stop-Process -Id`.
   Para scripts de apoyo, Node (`.mjs`), no Python.
8. **[2026-11-03] PowerShell 5.1: sin `&&`, sin `??`, sin ternario**
   Do instead: encadenar con `;` o `if ($?) { ... }`.
9. **[2026-11-03] Los PDF de `docs/diagramas/` usan fuentes CID**
   Do instead: no extraer su texto con regex sobre los streams; abrirlos en el
   panel del navegador (`file:///...`) y mirar la captura.

## SQL Server (T-SQL)
1. **[2026-11-03] Un error de sintaxis mata el LOTE entero, no la sentencia**
   SQL Server compila todo el lote antes de ejecutar nada. Sin `GO`, un error
   al final del archivo impide que se cree la primera tabla.
   Do instead: separar secciones con `GO`. Al diagnosticar "no se creo nada",
   buscar el error al FINAL del archivo, no al principio.
2. **[2026-11-06] `OUTPUT` sin `INTO` es ILEGAL en una tabla con triggers**
   Error 334. Muerde en `VENTA` (trigger del limite de credito) y mordera en
   `MOVIMIENTO_INVENTARIO`. El mensaje no dice que trigger lo causa.
   Do instead: `DECLARE @t TABLE (id INT); INSERT ... OUTPUT INSERTED.id INTO
   @t ...; SELECT id FROM @t;` como en `insertarVenta()`.
3. **[2026-11-06] Una cadena ISO con desplazamiento pierde el desplazamiento**
   `CAST('2026-11-06T18:30:00-06:00' AS DATETIME2)` guarda las 18:30, no las
   00:30 UTC: seis horas de corrimiento SIN ningun error.
   Do instead: convertir en JS (`new Date(iso)`) y pasar el Date; el driver lo
   manda en UTC. Si hay que hacerlo en SQL,
   `CAST(CAST(@x AS DATETIMEOFFSET) AT TIME ZONE 'UTC' AS DATETIME2(3))`.
4. **[2026-11-06] `SET QUOTED_IDENTIFIER ON` hace falta para CREAR el indice
   filtrado Y PARA ESCRIBIR en la tabla que lo tiene**
   SSMS lo pone solo; sqlcmd NO. Crear falla con "CREATE INDEX failed ... SET
   options"; un `UPDATE SESION` suelto desde sqlcmd falla con el Msg 1934, que
   habla de vistas indexadas y datos XML y no menciona el indice filtrado que
   es la causa. Tablas afectadas: SESION, CLIENTE, PRODUCTO, VENTA,
   MOVIMIENTO_INVENTARIO, CAJA, PAGO_CREDITO, INTENTO_LOGIN.
   Do instead: encabezar TODO script y TODA consulta `-Q` de sqlcmd con
   `SET QUOTED_IDENTIFIER ON;`. La API no lo necesita: el driver ODBC ya lo
   deja en ON.
5. **[2026-11-03] Los triggers se disparan por SENTENCIA, no por fila**
   `inserted` trae TODAS las filas. Un trigger escrito para una sola pierde
   datos en silencio cuando llega un lote de sincronizacion.
   Do instead: agrupar `inserted` con GROUP BY y aplicar por conjuntos.
6. **[2026-11-03] Un indice filtrado no puede comparar dos columnas**
   `WHERE cantidad <= cantidad_minima` falla con "Incorrect WHERE clause".
   Do instead: columna calculada PERSISTED con la comparacion, e indexarla.
7. **[2026-11-03] TRY/CATCH no atrapa errores de COMPILACION**
   Escribir una columna calculada, nombrar una columna inexistente, etc.
   revientan el lote antes de ejecutarlo.
   Do instead: envolver esa sentencia en `sp_executesql` para que el error
   ocurra en ejecucion y se pueda capturar.
8. **[2026-11-03] `DBCC CHECKIDENT RESEED 0` sobre tabla que nunca tuvo filas da id 0**
   Rompe todas las FK que apuntan al 1.
   Do instead: reiniciar solo si `sys.identity_columns.last_value IS NOT NULL`.
9. **[2026-11-05] Hay conector MCP de Lucid: el diagrama se crea desde aca**
   `lucid_create_erd` arma un ERD real y editable desde entidades y FK. NO
   existe forma de reemplazar el contenido de un documento ya creado: solo
   crear uno nuevo (`lucid_update_document` solo cambia titulo, carpeta y
   etiquetas).
   Do instead: para rehacer el modelo, crear documento nuevo y dejar el viejo
   como historial. Las razones de cada decision van en
   `docs/diagramas/DECISIONES-MODELO.md`.

## Driver de Node a SQL Server
1. **[2026-11-06] El servidor es SOLO autenticacion de Windows**
   `SERVERPROPERTY('IsIntegratedSecurityOnly') = 1`, asi que `tedious` (el
   driver puro JS de `mssql`) no puede conectar: pide usuario y contrasenia de
   SQL. Habilitar modo mixto exige cambiar la seguridad del servidor y
   reiniciar el servicio.
   Do instead: `mssql/msnodesqlv8.js` con `Trusted_Connection=yes`. Trae
   binarios precompilados (`prebuilds/win32-x64`), no compila nada aunque npm
   bloquee el script de instalacion.
2. **[2026-11-06] Los parametros NO pueden llamarse `p` + numero**
   `mssql` reserva `@p1, @p2...` para los que genera solo, y el servidor
   responde "The variable name '@p1' has already been declared".
   Do instead: nombres descriptivos (`@tienda_id`). `db.query` toma un OBJETO,
   no un arreglo posicional.
3. **[2026-11-06] Los tipos vuelven convertidos, no como texto**
   `BIT` -> booleano, `DECIMAL` -> number, `DATETIME2` -> Date. Al contrario
   de PostgreSQL, donde NUMERIC llegaba como string.
   Do instead: no envolver importes en `Number()` por costumbre. En SQL, `WHERE
   activo` no compila: va `WHERE activo = 1`.
4. **[2026-11-06] `rowsAffected` es un arreglo, una entrada por sentencia**
   Un lote `INSERT; UPDATE` devuelve `[3, 2]`.
   Do instead: usar `.at(-1)`, como hace `normalizar()` en `src/db.mjs`.
5. **[2026-11-06] El rollback falla si el error vino de un trigger**
   SQL Server ya aborto la transaccion, y `rollback()` lanza "no hay
   transaccion activa", tapando el error original.
   Do instead: el rollback va en su propio try/catch vacio, como en `db.tx()`.

## Domain Behavior Guardrails
1. **[2026-11-03] El stock se deduce de `MOVIMIENTO_INVENTARIO`, no se escribe**
   Do instead: para cambiar stock, insertar un movimiento con signo. La tabla
   `Stock` es cache que mantiene un trigger.
2. **[2026-11-03] El historial de movimientos es inmutable (trigger)**
   Do instead: para corregir un error, insertar un `ajuste` compensatorio.
   `UPDATE`/`DELETE` sobre esa tabla fallan a proposito (THROW 50001).
3. **[2026-11-06] La idempotencia va por `uuid_externo`, no por clave primaria**
   Las PK son `INT IDENTITY`: las asigna la base, el cliente no puede nombrar
   una operacion antes de enviarla. `uuid_externo` lo genera el dispositivo y
   tiene indice unico FILTRADO (admite muchos NULL).
   Do instead: insertar con `INSERT ... SELECT ... WHERE NOT EXISTS` y tratar
   el error 2601/2627 como duplicado. Nunca poner un DEFAULT en esa columna.
4. **[2026-11-06] El `numero` de venta lo asigna el SERVIDOR**
   Es unico por tienda. Si lo eligiera la tablet, dos tablets sin conexion en
   el mismo local elegirian el mismo y la segunda venta seria rechazada.
   Do instead: `MAX(numero)+1` con `WITH (UPDLOCK, HOLDLOCK)`, y devolverlo en
   la respuesta para que la tablet reconcilie su comprobante.
5. **[2026-11-06] El credito NO entra por `/sync/push`**
   El limite se comprueba contra el saldo en la base; dos tiendas sin conexion
   no se ven entre si y las dos fiarian el limite completo.
   Do instead: fiar exige conexion. `reglasDeSincronizacion()` lo rechaza con
   motivo `regla`, no con un error de base.
6. **[2026-11-03] Los movimientos de venta los deriva el servidor**
   Do instead: nunca aceptar movimientos de tipo `venta` desde el cliente; se
   generan en `insertarVenta()` a partir de las lineas.
7. **[2026-11-06] Los importes se calculan en SQL, no en JavaScript**
   La base exige `subtotal = ROUND(cantidad * precio, 2) - descuento`.
   Calcularlo con punto flotante y dejar que la base lo recalcule en DECIMAL
   hace que un caso de redondeo al borde rechace una venta valida.
   Do instead: `CAST(@x AS DECIMAL(18,2))` dentro del INSERT, y derivar la
   cabecera de las lineas con un UPDATE posterior. En JS, toda comparacion de
   importes redondea el RESULTADO, no solo los operandos: `r2(r2(a) - r2(b))`.
   `r2(a) - r2(b)` da 0.30000000000000004 y rechazaba rebajas con centavos
   (prueba 28). El cliente usa las mismas reglas en `cliente/logica.js`.
8. **[2026-11-06] La tienda del empleado sale de la SESION, no del usuario**
   Un empleado puede estar en las dos (`USUARIO_TIENDA`); elige cual al
   entrar y queda en `SESION.tienda_id`.
   Do instead: usar `puedeOperarEn(usuario, tiendaId)`, nunca leer una
   `tienda_id` del cuerpo de la peticion para decidir permisos.
9. **[2026-11-03] Agregar ventas con sus lineas causa fan-out**
   Do instead: agregar las lineas en un CTE previo (una fila por venta) y
   recien ahi unir con la cabecera. Ya mordio una vez: ganancia inflada de 60 a 185.
10. **[2026-11-06] Todo reporte por DIA convierte a hora local, y la zona vive
   solo en la base**
   Se guarda UTC y Nicaragua es UTC-6, asi que agrupar por
   `CAST(ocurrido_en AS DATE)` cuenta las ventas de la tarde en el dia
   siguiente -- sin ningun error, solo el total corrido. Ya mordio.
   Do instead: `dbo.fn_fecha_local(momento)` para saber el dia de un instante
   y `dbo.fn_inicio_utc_del_dia(fecha)` para los extremos de un rango (asi el
   filtro usa IX_VENTA_FECHA en lugar de convertir cada fila). La API NO nombra
   zonas horarias: la zona esta 3 veces y las 3 en `db/schema.sql` (seccion
   3.4 y `v_ventas_diarias`). La vista lleva la expresion a mano porque
   `fn_fecha_local` tiene `inline_type = 0`: dentro de un GROUP BY correria
   fila por fila.

## User Directives
1. **[2026-11-03] Todo el proyecto esta en espaniol, sin tildes en el codigo**
   Do instead: nombres de tablas, rutas, variables, funciones y comentarios en
   espaniol. Codigo y comentarios sin tildes; la documentacion `.md` si las lleva.
2. **[2026-11-03] Los comentarios explican POR QUE, no QUE**
   Do instead: al escribir codigo nuevo, documentar la decision y el escenario
   que la motiva (como en `sync.mjs` y `SCHEMA.md`), no parafrasear la linea.
3. **[2026-11-03] Los pendientes se dejan escritos en el codigo**
   Do instead: marcar lo que falta con un bloque `PENDIENTE` explicito que
   liste los puntos concretos.
