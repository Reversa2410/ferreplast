# Diseño de la base de datos

Documento de decisiones de diseño del esquema de Ferreplast. Explica **por qué**
el modelo es como es; la definición concreta está en [`db/schema.sql`](../db/schema.sql).

---

## 1. Por qué PostgreSQL

La elección no es por moda: viene de tres exigencias concretas del problema.

**El inventario y la caja son dinero.** Un sistema que pierde una venta o
duplica un descuento de stock es peor que el cuaderno de papel, porque el error
es invisible. PostgreSQL da transacciones ACID reales: cuando se registra una
venta, o se guardan la cabecera, las líneas y los movimientos de inventario
*todos juntos*, o no se guarda nada. No existe el estado intermedio en el que
la venta quedó registrada pero el stock no se descontó.

**Las reglas del negocio se pueden imponer en la base.** Que una venta no pueda
aumentar el stock, que una tienda no pueda tener dos cajas abiertas, que el
total sea igual al subtotal menos el descuento: todo eso son restricciones
declaradas en el esquema. Aunque la aplicación tenga un bug, o alguien se
conecte con `psql` y cargue datos a mano, la base rechaza lo imposible. En una
base sin esquema esas reglas viven solo en el código, y con el código fallan.

**Los reportes son consultas, no programas.** "Ganancia por tienda del último
trimestre agrupada por categoría" es una consulta SQL de diez líneas. Sin un
motor relacional habría que traer todo a memoria y calcularlo a mano.

Como efecto secundario útil, es también el motor que mejor se presta a la
materia: normalización, claves foráneas, índices, vistas, triggers, funciones y
transacciones aparecen todos en este esquema resolviendo un problema real, no
como ejercicio.

Sobre alternativas: **MySQL** habría servido, pero PostgreSQL tiene tipos
`ENUM` propios, columnas generadas, índices parciales y CTE modificantes, que
en este modelo se usan de forma central. **MongoDB** o similares se descartan
porque el problema es intrínsecamente relacional (ventas, líneas, productos,
tiendas, usuarios) y porque no ofrecen las garantías de integridad que el
manejo de dinero exige.

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

La solución es que **el UUID lo genere el dispositivo, no el servidor**. Por eso
`movimientos_inventario.id` y `ventas.id` no tienen `DEFAULT gen_random_uuid()`:
el identificador viene de afuera. El servidor inserta con:

```sql
INSERT INTO movimientos_inventario (...) VALUES (...)
ON CONFLICT (id) DO NOTHING;
```

El segundo envío choca con la clave primaria y se descarta sin efecto. Reenviar
cien veces el mismo movimiento produce el mismo resultado que enviarlo una vez:
eso es ser **idempotente**, y es lo que permite reintentar sin miedo.

`sync_log` registra cuántos registros se enviaron, cuántos se aceptaron y
cuántos se descartaron por duplicado, para poder diagnosticar la sincronización
cuando algo va mal.

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
| Tipos `ENUM` | `tipo_movimiento`, `rol_usuario`, … | Impide valores inválidos por error de tipeo |
| `CHECK` de signo | `movimientos_inventario` | Una venta no puede aumentar el stock |
| `CHECK` de credenciales | `usuarios` | Un admin necesita contraseña; un empleado, PIN y tienda |
| `CHECK` de coherencia | `ventas` | El total debe ser subtotal menos descuento |
| Clave primaria compuesta | `stock` | Una sola fila por tienda y producto |
| Índice único parcial | `cajas` | Una sola caja abierta por tienda a la vez |
| Índice parcial | `stock` (bajo mínimo) | Índice pequeño y alertas instantáneas |
| Índice GIN + `pg_trgm` | `productos.nombre` | Búsqueda por texto parcial en el mostrador |
| Columna generada | `cajas.diferencia` | El faltante nunca queda inconsistente |
| Trigger de caché | `stock` | Consulta rápida sin perder la fuente de verdad |
| Trigger de inmutabilidad | `movimientos_inventario` | El historial no se puede alterar |
| Vistas | `v_*` | Los reportes no se reescriben en cada pantalla |

### Sobre los `ENUM`

Ventaja: la base rechaza cualquier valor fuera de la lista. Desventaja: agregar
un valor exige `ALTER TYPE ... ADD VALUE`. Se eligieron para listas que casi no
cambian (tipos de movimiento, roles). Para algo que sí cambia seguido —como las
categorías de producto— se usó una **tabla** con clave foránea, que es el otro
lado de ese compromiso.

---

## 8. Verificación

El esquema no se da por bueno porque compile. `db/test-esquema.mjs` levanta una
instancia real de PostgreSQL, carga esquema y datos, y comprueba que las reglas
se cumplan: que el trigger calcule bien, que las restricciones rechacen lo que
deben rechazar, que reenviar un movimiento no lo duplique, que la reconciliación
detecte y corrija desalineaciones, y que los reportes den los números correctos.

```bash
npm run db:test
```

Esas pruebas ya encontraron un error real: la vista de ventas diarias unía
`ventas` con `venta_lineas` y sumaba directamente, de modo que una venta con dos
artículos se contaba dos veces y la ganancia salía inflada —185 en lugar de 60—.
Es el error de agregación por *fan-out*, y es especialmente peligroso porque el
número resultante parece razonable y nadie lo cuestiona. Se corrigió agregando
las líneas en un CTE previo, de modo que cada venta se cuente una sola vez.

---

## 9. Pendientes

Cosas conscientemente fuera del alcance actual, a decidir con los datos del
levantamiento de requerimientos:

- **Proveedores y compras.** Hoy una entrada registra el costo pero no a quién
  se le compró.
- **Clientes y ventas a crédito.** El `metodo_pago` contempla `credito`, pero no
  existe la tabla de cuentas por cobrar.
- **Precios por tienda.** El modelo asume precio único. Si las dos tiendas
  cobran distinto, hace falta una tabla `precios_por_tienda`.
- **Transferencias entre tiendas.** Mover mercadería de una esquina a la otra
  hoy se representa con dos movimientos sueltos (una salida y una entrada) sin
  vínculo entre sí.
- **Particionado por fecha** de `movimientos_inventario`, si el volumen lo
  justifica en algunos años.
