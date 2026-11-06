# Diseño de la base de datos

Documento de decisiones de diseño del esquema de Ferreplast. Explica **por qué**
el modelo es como es; la definición concreta está en [`db/schema.sql`](../db/schema.sql).

---

> **Motor: Microsoft SQL Server.** El proyecto empezó sobre PostgreSQL y migró
> a SQL Server. El modelo relacional es el mismo; lo que cambia es cómo se
> expresa cada regla. Las diferencias concretas están señaladas a lo largo del
> documento. La versión PostgreSQL quedó archivada en `db/_postgresql/` como
> referencia.

---

## 1. Por qué una base relacional

La elección no es por moda: viene de tres exigencias concretas del problema.

**El inventario y la caja son dinero.** Un sistema que pierde una venta o
duplica un descuento de stock es peor que el cuaderno de papel, porque el error
es invisible. Un motor relacional da transacciones ACID reales: cuando se
registra una venta, o se guardan la cabecera, las líneas y los movimientos de
inventario *todos juntos*, o no se guarda nada. No existe el estado intermedio
en el que la venta quedó registrada pero el stock no se descontó.

**Las reglas del negocio se pueden imponer en la base.** Que una venta no pueda
aumentar el stock, que una tienda no pueda tener dos cajas abiertas, que el
total sea igual al subtotal menos el descuento: todo eso son restricciones
declaradas en el esquema. Aunque la aplicación tenga un bug, o alguien se
conecte con `psql` y cargue datos a mano, la base rechaza lo imposible. En una
base sin esquema esas reglas viven solo en el código, y con el código fallan.

**Los reportes son consultas, no programas.** "Ganancia por tienda del último
trimestre agrupada por categoría" es una consulta SQL de diez líneas. Sin un
motor relacional habría que traer todo a memoria y calcularlo a mano.

Como efecto secundario útil, es también lo que mejor se presta a la materia:
normalización, claves foráneas, índices, vistas, triggers, procedimientos,
columnas calculadas y transacciones aparecen todos en este esquema resolviendo
un problema real, no como ejercicio.

**MongoDB** o similares se descartan porque el problema es intrínsecamente
relacional (ventas, líneas, productos, tiendas, usuarios) y porque no ofrecen
las garantías de integridad que el manejo de dinero exige.

### Qué cambió al pasar de PostgreSQL a SQL Server

El modelo es el mismo; lo que cambia es cómo se escribe cada regla. Los cuatro
puntos donde hubo que resolver distinto:

| Lo que hacía PostgreSQL | Cómo se resuelve en SQL Server |
|---|---|
| Tipos `ENUM` propios | Restricción `CHECK` con la lista de valores |
| Índice parcial comparando **dos columnas** (`cantidad <= cantidad_minima`) | No se puede: se calcula una columna `PERSISTED` y se indexa esa |
| Columna generada (`diferencia`) | Columna calculada `AS (...) PERSISTED` |
| `ON CONFLICT DO NOTHING` para la idempotencia | Índice único filtrado sobre `uuid_externo` |

Y una diferencia de comportamiento que no es de sintaxis sino de semántica, y
que hay que tener presente al escribir triggers: **en SQL Server el trigger se
dispara una vez por sentencia, no una vez por fila.** `inserted` es una tabla
con todas las filas afectadas. Un trigger escrito como si trajera una sola
funciona en las pruebas de a una y pierde datos en silencio en cuanto llega un
lote de sincronización. Por eso `trg_movimiento_actualiza_stock` agrupa
`inserted` antes de aplicar nada, y hay una prueba dedicada a ese caso.

---

## 2. La decisión central: el inventario es un registro de movimientos

Es lo que más define el modelo, así que conviene entenderlo bien.

### El enfoque obvio (y por qué no sirve acá)

Lo natural sería una columna `stock` en cada producto, que sube cuando entra
mercadería y baja cuando se vende:

```sql
UPDATE stock SET cantidad = cantidad - 3 WHERE producto_id = ...;
```

Funciona perfecto **mientras haya una sola fuente de escritura y conexión
permanente**. Ninguna de las dos condiciones se cumple: hay dos tiendas, cada
una con su tablet, y la conexión es intermitente.

El escenario que rompe este enfoque:

1. La tablet pierde internet a las 10:00 con 50 tornillos en stock.
2. Vende 3. Localmente anota "quedan 47".
3. Mientras tanto, desde el panel se registra la llegada de 100 tornillos: el
   servidor dice 150.
4. Vuelve la conexión y la tablet sincroniza "el stock es 47".
5. **Los 100 tornillos que entraron desaparecieron.**

El problema no es la sincronización: es *qué* se sincroniza. Enviar un estado
final ("quedan 47") pisa lo que hicieron los demás.

### El enfoque adoptado

No se guarda el stock. Se guarda **cada hecho que lo modificó**, en
`movimientos_inventario`:

| tipo | cantidad | significado |
|---|---|---|
| `entrada` | +100 | llegó mercadería del proveedor |
| `venta` | −3 | se le vendió a un cliente |
| `devolucion` | +1 | el cliente devolvió |
| `merma` | −2 | se rompió, se venció, se perdió |
| `ajuste` | ±n | corrección tras conteo físico |

El stock es la suma:

```sql
SELECT SUM(cantidad) FROM movimientos_inventario
WHERE tienda_id = ... AND producto_id = ...;
```

Rehaciendo el escenario anterior: la tablet envía `−3` y el panel envía `+100`.
Lleguen en el orden que lleguen, el resultado es `50 − 3 + 100 = 147`. **No hay
nada que pisar**, porque nadie afirma cuál es el total; cada uno aporta su
delta. La suma es conmutativa, y de ahí sale la propiedad que hace viable el
trabajo sin conexión.

Además se ganan tres cosas:

- **Auditoría completa.** Ante una diferencia en el conteo físico se ve
  exactamente qué pasó, quién lo hizo y cuándo.
- **Reconstrucción histórica.** "¿Cuánto stock había el 15 de agosto?" se
  responde sumando hasta esa fecha. Con una columna que se sobrescribe, esa
  información no existe.
- **Distinguir merma de venta.** Ambas bajan el stock, pero una es ingreso y la
  otra es pérdida. Con un solo número no se diferencian.

El costo es que la tabla crece siempre y que consultar el stock requiere sumar.
Lo segundo se resuelve en la sección siguiente; lo primero no es problema real
a esta escala (dos tiendas generan del orden de decenas de miles de filas al
año, algo que PostgreSQL maneja sin esfuerzo).

### El historial es inmutable

Un trigger (`trg_movimientos_inmutables`) impide `UPDATE` y `DELETE` sobre la
tabla. Si alguien se equivocó al cargar, no se corrige el registro viejo: se
inserta un `ajuste` que compensa. Así el historial nunca miente, y el error y su
corrección quedan ambos a la vista.

---

## 3. La tabla `stock`: desnormalización deliberada

La pantalla de venta consulta el stock cada vez que el empleado toca una tecla.
Sumar miles de movimientos en cada pulsación sería lento.

Por eso existe la tabla `stock`, que guarda el total ya calculado. Un trigger
(`trg_movimiento_actualiza_stock`) la mantiene al día con cada movimiento
insertado, usando `INSERT ... ON CONFLICT DO UPDATE` para crear la fila la
primera vez y sumarle después, de forma atómica.

Es importante entender la jerarquía: **`stock` es un dato derivado, no la
verdad**. La verdad siempre es `movimientos_inventario`. Si el caché se
desalinea, se regenera con `fn_recalcular_stock()`, que compara ambos, corrige
las diferencias e informa cuáles corrigió. Esa función es la red de seguridad
que hace aceptable la duplicación del dato.

---

## 4. Sincronización idempotente

El otro problema del trabajo sin conexión es el reenvío. La tablet manda una
venta, el servidor la guarda, y la confirmación se pierde por el camino. La
tablet no sabe si llegó, así que reintenta. Si el servidor la vuelve a
procesar, **el stock se descuenta dos veces**.

La solución es que **el identificador lo genere el dispositivo, no el
servidor**.

Acá aparece una tensión concreta con el modelo. La clave primaria es
`INT IDENTITY`: la asigna el servidor, es corta, legible y cómoda para las
claves foráneas. Pero justamente por eso **no sirve para detectar un reenvío**:
el segundo envío de la misma venta obtendría un id nuevo y entraría como si
fuera otra.

Por eso `MOVIMIENTO_INVENTARIO` y `VENTA` llevan **dos** identificadores:

| Columna | Quién la genera | Para qué |
|---|---|---|
| `id` | el servidor (`IDENTITY`) | identificar la fila, enlazar claves foráneas |
| `uuid_externo` | el dispositivo | reconocer que esto ya llegó antes |

Sobre `uuid_externo` hay un **índice único filtrado**. El segundo envío choca y
se descarta. Reenviar cien veces el mismo movimiento produce el mismo resultado
que enviarlo una vez: eso es ser **idempotente**, y es lo que permite
reintentar sin miedo.

El índice es *filtrado* (`WHERE uuid_externo IS NOT NULL`) por una razón
práctica: los movimientos cargados desde el panel, que nunca estuvieron en una
tablet, no tienen identificador externo. Con un `UNIQUE` común, SQL Server
admitiría **uno solo** de esos en toda la tabla.

`SYNC_LOG` registra cuántos registros se enviaron, cuántos se aceptaron y
cuántos se descartaron por duplicado. Los duplicados no son un error: son la
prueba de que el reintento funcionó como debía.

---

## 5. Precios congelados en la venta

`productos` guarda el precio **vigente**. `venta_lineas` guarda una copia del
`precio_unitario` y del `costo_unitario` del momento de vender.

Es duplicación a propósito. Sin ella, subir el precio del balde de 38 a 45
haría que todos los reportes de ganancia del año pasado se recalcularan solos,
mostrando utilidades que nunca ocurrieron. Congelando el precio en la línea,
cada venta conserva su verdad histórica y los reportes del pasado no cambian.

Guardar también el **costo** es lo que permite calcular el margen real: no
cuánto se vendió, sino cuánto se ganó.

---

## 6. Dos tiendas, un catálogo

`productos` no tiene `tienda_id`. Un producto pertenece al negocio, no a una
tienda; lo que varía por tienda es el `stock`. Así, corregir el nombre o el
precio de un artículo se hace en un solo lugar y vale para ambas.

`stock` usa clave primaria compuesta `(tienda_id, producto_id)`, lo que hace
imposible por diseño que existan dos filas contradictorias para el mismo par.

### La tabla `negocios`

Hoy tiene una sola fila y parece sobrar. Está por una razón concreta: el
sistema se piensa para venderlo a otras familias. Con esta tabla, sumar un
cliente es insertar una fila. Sin ella, habría que agregar la noción de
"a quién pertenece esto" a tablas ya cargadas con datos reales de producción,
que es una de las migraciones más caras que existen. Cuesta dos claves foráneas
ahora y evita ese problema después.

---

## 7. Elementos del esquema y qué resuelve cada uno

| Elemento | Dónde | Qué problema resuelve |
|---|---|---|
| `CHECK` de lista | `tipo`, `rol`, `metodo_pago`, `estado` | Impide valores inválidos por error de tipeo |
| `CHECK` de signo | `MOVIMIENTO_INVENTARIO` | Una venta no puede aumentar el stock |
| `CHECK` de credenciales | `Usuario` | Un administrador necesita contraseña; un empleado, PIN |
| `CHECK` de deudor | `VENTA` | No se puede fiar sin registrar a quién |
| `CHECK` de rebaja | `VENTA_LINEA` | No se puede descontar más de lo que vale el renglón |
| `UNIQUE` compuesto | `VENTA_LINEA (venta_id, producto_id)` | Un producto, una línea: la rebaja no queda partida |
| Clave primaria compuesta | `USUARIO_TIENDA` | Un empleado no se asigna dos veces a la misma tienda |
| Trigger de límite | `VENTA` | No se fía por encima del cupo del cliente |
| `CHECK` de coherencia | `VENTA` | El total debe ser subtotal menos descuento |
| `CHECK` de cierre | `CAJA` | No se puede cerrar un turno sin contar el efectivo |
| `CHECK` de vigencia | `SESION` | Una sesión no puede caducar antes de haber nacido |
| Clave primaria compuesta | `Stock` | Una sola fila por tienda y producto |
| Clave primaria compuesta | `VENTA_LINEA` | Entidad débil: la línea solo existe dentro de su venta |
| `UNIQUE` compuesto | `VENTA (tienda_id, numero)` | Dos facturas no comparten número en una tienda |
| Índice único filtrado | `CAJA` (abiertas) | Una sola caja abierta por tienda a la vez |
| Índice único filtrado | `uuid_externo` | Idempotencia, admitiendo muchos NULL |
| Índice único filtrado | `PRODUCTO.codigo`, `Usuario.email` | Único si existe, opcional si no |
| Índice filtrado | `SESION` (vivas) | Las sesiones muertas no engordan el índice que se consulta en cada petición |
| Índice filtrado | `INTENTO_LOGIN` (fallidos) | El conteo de bloqueo solo mira fallos; los aciertos quedan para auditoría |
| Columna calculada | `Stock.necesita_reposicion` | La alerta no se puede falsear a mano |
| Trigger de caché | `Stock` | Consulta rápida sin perder la fuente de verdad |
| Trigger de inmutabilidad | `MOVIMIENTO_INVENTARIO` | El historial no se puede alterar |
| Procedimiento | `sp_recalcular_stock` | Red de seguridad del caché |
| Vistas | `v_*` | Los reportes no se reescriben en cada pantalla |

### Sobre las listas de valores

PostgreSQL permite declarar un tipo `ENUM`; SQL Server no. El equivalente es
una restricción `CHECK`, que da la misma garantía —la base rechaza cualquier
valor fuera de la lista— con dos diferencias: los valores válidos no se pueden
consultar desde el catálogo del sistema tan cómodamente, y agregar uno exige
`ALTER TABLE` en lugar de `ALTER TYPE`.

Se usan para listas que casi no cambian (tipos de movimiento, roles, métodos de
pago). Para algo que sí cambia seguido —como las categorías de producto— se usó
una **tabla** con clave foránea, que es el otro lado de ese compromiso.

### Sobre `float` y el dinero

Todos los importes y cantidades son `DECIMAL`, nunca `FLOAT`. Un `float` no
puede representar 0.10 exactamente: sumar cien veces diez centavos no da diez.
En inventario y caja eso es inaceptable, y el error es del tipo que aparece
recién cuando el arqueo no cuadra por centavos y nadie entiende por qué.

---

## 8. Verificación

El esquema no se da por bueno porque compile. `db/test-esquema.sql` corre **33
pruebas** contra la base cargada: cada una intenta algo que debería ser
imposible y verifica que la base lo rechace, o hace algo válido y comprueba que
el resultado sea correcto. Ninguna deja rastro —cada una escribe dentro de una
transacción que se revierte—.

```bash
sqlcmd -S localhost -E -C -f 65001 -i db/test-esquema.sql
```

Qué cubren: el signo de los movimientos, la inmutabilidad del historial, el
trigger de stock (incluido el caso de **lote de varias filas**, que es el que
rompe los triggers mal escritos), la idempotencia del reenvío, la coherencia de
las ventas, la unicidad del número de factura por tienda, la caja única
abierta, las reglas de credenciales, la columna calculada y las cuatro vistas.

Las pruebas ya encontraron errores reales:

- **Fan-out en el reporte de ganancia.** La vista de ventas diarias unía la
  cabecera con las líneas y sumaba directamente, de modo que una venta con dos
  artículos se contaba dos veces. Es especialmente peligroso porque el número
  resultante parece razonable y nadie lo cuestiona. Se corrigió agregando las
  líneas en un CTE previo. Hay una prueba dedicada: la venta de 880 con dos
  líneas tiene que seguir dando 880, no 1760.

- **`DBCC CHECKIDENT ... RESEED, 0` sobre una tabla que nunca tuvo filas** hace
  que la primera inserción tome el id **0**, no el 1 — y entonces todas las
  claves foráneas que apuntan al 1 fallan. Solo se reinicia el contador cuando
  la tabla ya tuvo filas.

- **`TRY/CATCH` no atrapa errores de compilación.** Escribir una columna
  calculada revienta el lote completo antes de ejecutar nada, así que la prueba
  que verificaba eso se llevaba puestas a las que venían después. Se resolvió
  envolviendo esa sentencia en `sp_executesql`, para que el error ocurra en
  ejecución y se pueda capturar.

Ese último punto es la misma trampa que vale para todo el archivo: **SQL Server
compila el lote entero antes de ejecutar una sola línea**. Sin separadores `GO`,
un error de sintaxis al final del script impide que se cree la primera tabla.

---

## 9. Quién entra y qué puede hacer

Dos tablas sostienen la autenticación: `sesiones` e `intentos_login`.

### Por qué una tabla de sesiones y no un token autocontenido

Lo habitual hoy sería un JWT: un token que lleva adentro quién es el usuario,
firmado para que no se pueda falsificar. No necesita consultar la base, que es
su gran ventaja.

Su defecto es que **no se puede revocar**. Un token firmado vale hasta que
caduca, y el servidor no tiene forma de invalidarlo sin cambiar la clave de
firma, lo que echaría a todos los usuarios a la vez. En este negocio eso importa
concretamente: si una tablet se pierde o un empleado deja de trabajar, hay que
poder cortarle el acceso en el momento, no cuando el token expire.

Con una tabla, revocar es `UPDATE sesiones SET revocada_en = NOW()`. El precio
es una consulta por petición; con dos tiendas no se nota.

### Por qué se guarda el hash del token y no el token

El mismo razonamiento que con las contraseñas: si alguien consigue un volcado de
la base, con los tokens en claro entra como cualquier usuario que tenga sesión
abierta.

Lo que sí cambia es **qué hash**. Para el token alcanza SHA-256; para la
contraseña no. La diferencia está en lo que se protege: un token son 32 bytes al
azar, así que no hay diccionario que probar y no hace falta que cada intento sea
caro. Una contraseña —y sobre todo un PIN de 4 dígitos— es adivinable, y ahí lo
único que ayuda es encarecer cada prueba. Por eso las claves usan **scrypt**,
que exige CPU y memoria deliberadamente.

### Por qué el límite de intentos no es opcional

Un PIN de 4 dígitos son 10.000 combinaciones. Un programa que pruebe una por
segundo las agota en menos de tres horas. **El hash no protege de esto**: el
hash protege de que roben la base, no de que prueben por la puerta de entrada.

`intentos_login` registra cada intento. Pasados 5 fallos en 15 minutos se
rechaza aunque la clave sea correcta —si no, bastaría con seguir probando hasta
acertar—. La ventana se vacía sola en lugar de requerir que un admin desbloquee,
porque si no, cualquiera podría dejar al mostrador sin vender tecleando cinco
PIN malos, y en una tienda sin internet no hay nadie a mano que lo arregle.

También se registran los **aciertos**: el patrón "veinte fallos y un acierto" es
la firma de un ataque que funcionó, y sin los aciertos no se ve.

El conteo se hace en la base y no en memoria del proceso: si la API corriera en
dos instancias, un contador en memoria permitiría el doble de intentos sin que
nadie lo note.

### El alcance por tienda

El empleado solo opera sobre su tienda; el administrador, sobre las dos. Sin esa
regla, cualquier empleado podría descontar stock del otro local cambiando un
identificador en la petición.

**De dónde sale "su tienda".** Ya no de `Usuario`. El levantamiento dice que
algunos empleados trabajan en los dos locales, así que la pertenencia vive en
`USUARIO_TIENDA` (varias filas por persona) y la tienda desde la que está
operando ahora vive en `SESION.tienda_id`, elegida al entrar.

Son dos cosas distintas y conviene no confundirlas: *a dónde pertenece* es un
permiso, *desde dónde está vendiendo* es un hecho del turno. Para el alcance de
los datos manda el segundo.

La comprobación se hace **por elemento del lote**, no por lote: una tablet puede
enviar operaciones de las dos tiendas, y la que no corresponde se aparta sola sin
tumbar al resto, igual que un registro mal formado.

### Qué no resuelve

El autor de cada venta (`usuario_id`) lo sigue poniendo el cliente, y es
deliberado: la tablet acumula las ventas del día y durante ese día pudieron
atenderla dos empleados distintos. Quien sincroniza al final no es
necesariamente quien vendió, así que forzar el autor al de la sesión atribuiría
todo al último que tocó la tablet.

Lo que falta es comprobar que ese usuario pertenezca a la misma tienda. Hoy la
clave foránea garantiza que exista, no que sea de ahí.

---

## 10. Pendientes

Cosas conscientemente fuera del alcance actual, a decidir con los datos del
levantamiento de requerimientos:

- **Proveedores y compras.** Hoy una entrada registra el costo pero no a quién
  se le compró.
- **Precios de mayoreo por producto.** Hoy la rebaja la negocia el empleado y se
  registra en `VENTA_LINEA.descuento`. Si algún día la dueña fija escalas
  ("de 12 en adelante, tanto"), hace falta una tabla `PRECIO_MAYOREO`
  (`producto_id`, `cantidad_minima`, `precio_unitario`) y el sistema las
  aplicaría solo.
- **Crédito sin señal.** Decisión consciente: con la conexión caída **no se
  fía**. Dos tiendas desconectadas podrían pasarse del cupo cada una por su
  lado, y al sincronizar ya no habría nada que hacer. El costo es real: justo
  cuando se va la luz es cuando el cliente de confianza quiere llevarse las
  cosas.
- **La fecha de los reportes está en UTC, no en hora local.** `v_ventas_diarias`
  agrupa por `CAST(ocurrido_en AS DATE)`, y `ocurrido_en` se guarda en UTC.
  Nicaragua es UTC-6, así que una venta de las 18:30 de la tarde (00:30 UTC del
  día siguiente) se cuenta en el día equivocado — y para una ferretería que
  cierra a la tarde, eso desplaza las últimas ventas de cada día. **Es un error
  real en la pantalla principal de la dueña**, no una sutileza. El arreglo es
  en la vista, no en la API:

  ```sql
  CAST(ocurrido_en AT TIME ZONE 'UTC'
                   AT TIME ZONE 'Central America Standard Time' AS DATE)
  ```

  Queda sin aplicar porque cambia números que las pruebas del esquema ya
  verifican, y conviene hacerlo junto con la revisión de esas pruebas en lugar
  de mezclado con otro cambio. Está anotado también en
  `src/rutas/reportes.mjs`.
- **Transferencias entre tiendas.** Mover mercadería de una esquina a la otra
  hoy se representa con dos movimientos sueltos (una salida y una entrada) sin
  vínculo entre sí.
- **Particionado por fecha** de `movimientos_inventario`, si el volumen lo
  justifica en algunos años.
