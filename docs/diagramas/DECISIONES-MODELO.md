# Decisiones del modelo

El modelo final tiene **17 tablas, 5 vistas, 3 triggers y 46 pruebas** que lo
verifican. Este documento registra **por qué** es así, para que cada decisión
tenga su defensa y no haya que reconstruirla de memoria.

Sustituye a `CAMBIOS-MODELO.md`, que listaba cambios pendientes de aplicar al
diagrama. Ya están aplicados.

- Esquema: [`db/schema.sql`](../../db/schema.sql)
- Diagrama: **Ferreplast - Modelo relacional 3 (final)** en Lucidchart
- El diagrama anterior (12 tablas, sin nombre) queda como historial del "antes"

---

## 1. El requisito que sostiene medio modelo: trabajar sin internet

Las tiendas están en un pueblo donde la señal se cae seguido y los apagones
cortan el internet por ratos. No es un caso excepcional: es la condición normal
de trabajo.

**Esto no aparece en el levantamiento escrito.** Sale de conocer el lugar, y
quedó anotado en `docs/word/RespuestasDelNegocio.md` precisamente porque, sin
ese renglón, hay media docena de decisiones del modelo que no se entienden y
parecen sobreingeniería.

Lo que existe gracias a este requisito:

| | |
|---|---|
| `DISPOSITIVO`, `SYNC_LOG` | saber qué tablet sincronizó y cuándo |
| `uuid_externo` en `VENTA` y `MOVIMIENTO_INVENTARIO` | la tablet no sabe si su envío llegó, así que reintenta; el índice único descarta el reenvío |
| Stock derivado de movimientos | sincronizar *hechos* y no *totales* |
| `Stock` como caché con trigger | la pantalla de venta no puede sumar miles de movimientos por tecla |

### Por qué el stock no es una columna que sube y baja

Lo natural sería una columna. Funciona mientras haya una sola fuente de
escritura y conexión permanente, y no se cumple ninguna de las dos. El escenario
que lo rompe:

1. La tablet pierde internet con 50 tornillos en stock.
2. Vende 3. Localmente anota "quedan 47".
3. Mientras tanto entran 100 por el panel: el servidor dice 150.
4. Vuelve la conexión y la tablet sincroniza "el stock es 47".

Los 100 desaparecen. El problema no es sincronizar: es **qué** se sincroniza.
Enviando "vendí 3" en lugar de "el stock es 47", el servidor llega a 147 y nadie
pierde nada.

---

## 2. Crédito a clientes

El negocio **fía** (está en el levantamiento). El modelo anterior tenía
`metodo_pago = 'credito'` y **nadie a quien cobrarle**: se podía registrar la
deuda sin el deudor, y el sistema no sabía contestar *quién me debe y cuánto*,
que para un negocio que fía es la pregunta.

Entran `CLIENTE` y `PAGO_CREDITO`.

### El crédito es solo online — y por qué

Con offline, dos tiendas desconectadas pueden fiarle al mismo cliente el mismo
día sin que ninguna vea la deuda de la otra. Al sincronizar, ambas ventas son
válidas (no son duplicados, el `uuid_externo` no las frena) y el cupo ya se pasó.

Tres salidas posibles, y se eligió la segunda:

1. **Límite blando:** se fía igual y el sistema avisa al sincronizar. Honesto,
   pero el riesgo queda en el dueño.
2. **Crédito solo online** ← elegida. El servidor conoce el saldo real en el
   momento de la venta y puede rechazarla. La regla se *cumple*, no se audita
   después.
3. **Cupo repartido por tienda:** correcto y nadie lo administraría.

**El costo, que hay que decirlo antes de que lo pregunten:** cuando se va la
luz, no se fía. Es justo el momento en que el cliente de confianza igual se
lleva las cosas.

**Dónde vive la regla:** en el endpoint de sincronización, que rechaza toda
venta a crédito que llegue por lote. Una venta que llega por sync es, por
definición, una que se hizo sin señal. Si la regla viviera solo en la tablet,
bastaría una tablet desactualizada para meter deuda fantasma.

### El saldo no se guarda

Se deriva: ventas a crédito no anuladas menos abonos (`v_cuentas_por_cobrar`).
Mismo criterio que el stock, y da un efecto gratis: **anular una venta fiada
baja la deuda sola**. Con una columna de saldo habría que acordarse de restarla.

### El límite es un trigger, no un CHECK

Un `CHECK` solo ve la fila que se inserta; el límite compara contra la suma de
las *otras* ventas y de los abonos. Va en `trg_venta_credito_limite`.

Va en la base y no solo en la API por la misma razón que el `CHECK` de
credenciales: una regla que vive en el endpoint la saltea cualquier script que
inserte directo.

El trigger cubre **INSERT y UPDATE**. Solo con INSERT quedaba un agujero:
insertar la venta en cero y subirle el total después esquiva el límite por
completo, que es exactamente lo que hace cualquier flujo que arme la cabecera a
partir de las líneas. Hay una prueba para eso.

### El abono va contra la cuenta, no contra una factura

Con abonos parciales, atarlos a una venta obligaría al empleado a elegir qué
boletas cancela cuando el cliente le pone C$500 en el mostrador. Nadie hace eso.

### El detalle que rompe el arqueo

Un abono en efectivo es **plata que entra al cajón sin que haya una venta**.
`v_cuadre_caja` calcula el efectivo esperado desde las ventas del turno: si no
suma los abonos, un cliente que pasa a pagar una deuda vieja hace aparecer un
sobrante que no existe, y el empleado empieza a desconfiar del sistema.

Por eso `PAGO_CREDITO` lleva `caja_id`, y la vista los suma. El seed deja la
caja de Juan cuadrando **con** un abono adentro: si alguien saca los abonos de
la vista, esa caja deja de cuadrar y la prueba lo detecta.

---

## 3. Empleados que trabajan en las dos tiendas

El levantamiento dice que *"algunos empleados trabajan en ambas tiendas a la
vez"*. El modelo anterior no solo no lo soportaba: lo **prohibía**, con un
`tienda_id` único en `Usuario` y un `CHECK` que lo exigía.

La salida práctica —crear dos usuarios para la misma persona— parte en dos
cualquier reporte de "cuánto vendió Fulano" y le da dos PIN distintos.

Entra `USUARIO_TIENDA` con clave primaria compuesta.

### Aparece una pregunta nueva: ¿desde qué tienda está vendiendo?

Antes se deducía de `Usuario.tienda_id`. Si la persona pertenece a las dos, ya
no se puede deducir: **la elige al entrar**, y queda en `SESION.tienda_id`.

Son dos cosas distintas y conviene no confundirlas: *a dónde pertenece* es un
permiso; *desde dónde está vendiendo ahora* es un hecho del turno. Para el
alcance de los datos manda el segundo.

El flujo de ingreso ya funcionaba así (se elige tienda, se listan sus empleados,
se teclea el PIN), así que no hace falta una pantalla nueva.

### Lo que se perdió, dicho explícitamente

El `CHECK` de credenciales ya no puede exigir tienda: un `CHECK` no puede mirar
otra tabla. Esa garantía bajó de la base al código. Es el costo consciente de
admitir empleados compartidos.

---

## 4. El descuento es la rebaja por mayoreo, y vive en la línea

El negocio hace rebajas por mayoreo, pero **no tiene precios de mayoreo
cargados**: la rebaja la negocia el empleado en el mostrador.

Eso descarta una tabla de escalas de precio (sería ficción: nadie cargaría
escalas que no existen) y convierte a `descuento` en **el mecanismo del
mayoreo**, no en un campo genérico de relleno.

Y lo mueve de lugar: el mayoreo es sobre un **producto** ("te dejo más baratos
los tubos"), no sobre la boleta. Con un monto suelto en la cabecera hay que
prorratearlo entre las líneas para saber cuánto se ganó con cada producto, y
cualquier forma de prorratearlo es inventada.

Así que `descuento` pasa a `VENTA_LINEA`, y el de `VENTA` es la suma de los de
sus líneas.

**Beneficio secundario, que importa:** se puede saber cuánto margen se está
regalando y quién lo regala. Con el empleado negociando libremente, sin registro
por línea eso es un agujero invisible; con registro por línea, es un reporte.

Acompaña `UNIQUE (venta_id, producto_id)`: un producto, una línea. Si el mismo
artículo entra dos veces, la rebaja queda partida y el reporte por producto
miente.

---

## 5. `CAJA.diferencia` se guarda, y no contradice a `necesita_reposicion`

Parecen dos datos derivados tratados distinto. No lo son:

- `necesita_reposicion` compara **dos columnas de su propia fila** → puede ser
  columna calculada.
- `diferencia` depende de agregados de **otras tablas** → una columna calculada
  no puede hacer eso en SQL Server.

Pero el argumento de fondo es mejor que esa limitación técnica: **`diferencia`
es la fotografía de un conteo que ocurrió a una hora.** El empleado contó la
plata a las 6 y faltaban C$200. Eso es un hecho histórico, no una fórmula.

Recalcularlo mañana daría otro número — y con offline **da otro número seguro**,
porque una venta hecha sin señal puede sincronizar después del cierre.

Por eso conviven las dos cosas:

| | |
|---|---|
| `CAJA.diferencia` | qué pasó cuando se contó |
| `v_cuadre_caja.diferencia_real` | qué debería ser ahora, con todo lo que llegó después |

Y **compararlas es útil en sí mismo**: si no coinciden, aparecieron ventas
tarde. Es un dato, no un error. Mismo criterio que `costo_unitario` en la línea
de venta.

---

## 6. Dos roles, no tres

`empleado` y `administrador`. El `encargado` del modelo anterior no corresponde
a ninguna situación real del negocio.

Con dos roles el `CHECK` de credenciales se vuelve binario de verdad:

```
administrador -> email + password_hash
empleado      -> pin_hash
```

El literal en la base es `'administrador'`, no `'admin'`: todo el proyecto está
en español, y tener el dato como `admin` mientras la documentación dice
"administrador" es la clase de desfase que hace que alguien escriba
`rol = 'administrador'` en una consulta y no reciba nada.

---

## 7. Lo que se revisó y se dejó igual

- **`PRODUCTO` sin `tienda_id`.** El levantamiento dice que *"los precios de las
  tiendas son siempre iguales"*. El catálogo es del negocio; lo que varía por
  tienda es el stock.
- **`SESION` e `INTENTO_LOGIN` en el diagrama.** Son infraestructura, pero es un
  modelo relacional: si faltan tablas que están en el esquema, el modelo está
  incompleto, y eso es peor que estar cargado.
- **`MOVIMIENTO_INVENTARIO`.** Se sostiene aunque no hubiera offline: hoy el
  inventario se lleva a papel y lápiz y no hay forma de saber qué pasó con el
  stock (mermas, ajustes, quién tocó qué).

---

## 8. Un error que el script arrastraba

`db/schema.sql` prometía ser idempotente y no lo era: los `DROP TABLE` borraban
`VENTA` antes que `MOVIMIENTO_INVENTARIO`, que le apunta con `FK_MOV_VENTA`. La
segunda corrida fallaba **y aun así imprimía "Esquema creado correctamente"**,
que es la peor combinación posible.

Corregido el orden y verificado corriendo el script dos veces seguidas.
