# Cambios a aplicar en el diagrama

El esquema de `db/schema.sql` corrige varios problemas del modelo. El diagrama
de Lucidchart (`modelo relacional 2`) quedó desactualizado respecto de él.

Esta es la lista exacta de qué cambiar y **por qué**, para que al defenderlo
cada cambio tenga su justificación.

---

## 1. Dos entidades nuevas

### `SESION`

| Atributo | Tipo | Clave |
|---|---|---|
| token_hash | char(64) | PK |
| usuario_id | int | FK → Usuario |
| dispositivo_id | int | FK → DISPOSITIVO |
| expira_en | datetime | |
| revocada_en | datetime | |
| created_at | datetime | |

Relaciones: `Usuario ||--o{ SESION` (*Abre*), `DISPOSITIVO ||--o{ SESION` (*Desde*).

**Por qué:** sin ella no hay forma de cerrar la sesión de una tablet perdida.
Un token firmado tipo JWT no se puede revocar; una fila sí.

### `INTENTO_LOGIN`

| Atributo | Tipo | Clave |
|---|---|---|
| id | int | PK |
| identificador | string | |
| tienda_id | int | FK → TIENDA |
| exitoso | boolean | |
| ip | string | |
| created_at | datetime | |

Relación: `TIENDA ||--o{ INTENTO_LOGIN` (*Registra*).

**Por qué:** un PIN de 4 dígitos son 10.000 combinaciones; probándolas se
agotan en tres horas. El hash no protege de eso — protege de que roben la
base, no de que prueben por la puerta. Lo único que lo frena es contar fallos.

**Ojo:** no lleva FK a `Usuario` a propósito. Hay que poder registrar el intento
de entrar con un email que no existe, que es el caso interesante.

---

## 2. `PRODUCTO` — el cambio más importante

**Quitar:** `precio_costo_venta`
**Poner:** `precio_costo` (decimal) y `precio_venta` (decimal)

**Por qué:** con una sola columna hay que elegir entre guardar lo que cuesta o
lo que se cobra. Con cualquiera de las dos sola, la pregunta que el dueño no
puede contestar hoy —*cuánto gané*, no *cuánto vendí*— sigue sin respuesta, y
el inventario no se puede valorizar a costo.

Además `float` → **`decimal`** en todos los importes y cantidades del diagrama.
Un `float` no representa 0.10 exactamente: sumar cien veces diez centavos no da
diez. En dinero eso es inaceptable. (El script ya usaba `DECIMAL`; es la
etiqueta del diagrama la que dice `float`.)

---

## 3. `MOVIMIENTO_INVENTARIO`

**Quitar:** `append_only` (boolean)

**Por qué:** una columna no impide nada — es un dato, no una regla. Cualquier
`UPDATE` la ignora. La inmutabilidad ahora la impone un trigger
(`trg_movimientos_inmutables`), que es lo que de verdad bloquea la
modificación.

**Agregar:**

| Atributo | Tipo | Clave | Para qué |
|---|---|---|---|
| uuid_externo | uniqueidentifier | | idempotencia de la sincronización |
| usuario_id | int | FK → Usuario | quién lo hizo |
| venta_id | int | FK → VENTA | de qué venta salió |

Relaciones nuevas: `Usuario ||--o{ MOVIMIENTO_INVENTARIO` (*Registra*),
`VENTA ||--o{ MOVIMIENTO_INVENTARIO` (*Genera*).

**Por qué `uuid_externo`:** la tablet no sabe si su envío llegó —la respuesta
pudo perderse— así que reintenta. La clave primaria no sirve para detectar el
reenvío porque es `IDENTITY`: la asigna el servidor y el reintento obtendría un
id nuevo. El dispositivo genera además un GUID propio, y el índice único hace
que el segundo envío choque y se descarte.

**Por qué `usuario_id` y `venta_id`:** sin ellos se pierde la auditoría de quién
movió el stock, y un movimiento solo se liga a su factura leyendo el texto del
motivo.

**Anotación de CHECK a corregir.** Hoy el diagrama dice
`CHECK: venta, entrada, merma, ajuste`. Debe decir:

```
CHECK tipo: entrada, venta, devolucion, merma, ajuste
CHECK signo: entrada/devolucion > 0 ; venta/merma < 0
```

El segundo es el que importa: sin él, una venta puede **aumentar** el stock.

---

## 4. `Stock`

**Agregar:** `necesita_reposicion` (bit, **columna calculada**)

**Por qué:** en PostgreSQL se puede crear un índice parcial con
`WHERE cantidad <= cantidad_minima`. SQL Server **no admite comparar dos
columnas** en el filtro de un índice: falla con *Incorrect WHERE clause for
filtered index*. La vuelta es calcular la comparación una vez, persistirla e
indexarla. Al ser calculada no se puede escribir a mano, así que es imposible
que diga que un producto está bien de stock cuando no lo está.

En Lucidchart conviene marcarla con una nota «calculada», igual que `diferencia`
en el modelo anterior.

---

## 5. `CAJA`

**Mantener:** `diferencia` — tal como lo pidió el profesor. El efectivo
esperado **no** se guarda: es exactamente lo que `diferencia` ya expresa, y
almacenar los dos sería guardar el mismo dato dos veces con el riesgo de que se
contradigan. Lo esperado se recalcula en la vista `v_cuadre_caja`.

**Agregar:**

| Atributo | Tipo | Para qué |
|---|---|---|
| estado | string | abierta / cerrada / revisada |
| abierta_en | datetime | |
| cerrada_en | datetime | |

**Por qué:** sin estado ni fechas no se puede abrir ni cerrar un turno — la
tabla describe una caja que siempre existió y nunca cambia. Con `estado` se
puede imponer además, con un índice único filtrado, que haya **una sola caja
abierta por tienda**: sin eso, dos turnos solapados cobran contra la misma caja
y el arqueo no cuadra nunca.

`efectivo_contado` y `diferencia` pasan a admitir NULL: mientras la caja está
abierta todavía no se contó.

---

## 6. `Usuario`

- `tienda_id` pasa a **admitir NULL**. El administrador no pertenece a un
  local, ve los dos. Dejarlo obligatorio fuerza a inventarle una tienda y a
  recordar en cada consulta que ese valor no significa nada.
- `password_hash` pasa a **admitir NULL**: los empleados entran por PIN, no
  tienen contraseña.
- `rol`: el CHECK pasa de `administrador, empleado` a **`empleado, encargado,
  admin`**.
- Agregar `negocio_id` (FK → NEGOCIO), `activo`, `ultimo_acceso`.
- Anotar que `email` es **único** (índice filtrado: varios empleados pueden no
  tener email, pero dos no pueden compartir uno).

**Nota de CHECK:**

```
CHECK credenciales:
  admin  -> email y password_hash obligatorios
  otros  -> pin_hash y tienda_id obligatorios
```

Sin esta regla se pueden crear usuarios que no pueden entrar por ningún lado, y
el error aparece recién cuando esa persona intenta trabajar.

---

## 7. `VENTA`

- Agregar `uuid_externo` (misma idea que en los movimientos).
- Anotar `UNIQUE (tienda_id, numero)`: dos facturas no pueden compartir número
  dentro de una tienda, pero cada tienda numera en paralelo aunque estén
  desconectadas.
- Anotar `CHECK total = subtotal - descuento`.

---

## 8. `SYNC_LOG`

**Agregar:** `registros_aceptados` (int).

Hoy están `enviados` y `duplicados`, y falta justamente el del medio. Sin él no
se puede distinguir "llegaron 85 y entraron 83 porque 2 eran reenvíos" de
"llegaron 85 y se perdieron 2".

---

## 9. `NEGOCIO` y `TIENDA`

- `NEGOCIO.activo`: de `string` a **`bit`**. Un booleano guardado como texto
  admite `'si'`, `'Si'`, `'SI'`, `'S'`, y el día que alguien escriba uno
  distinto la consulta que filtra `activo = 'si'` deja de ver esa fila sin
  avisar.
- `TIENDA`: agregar `activo` (bit).

---

## Resumen

| | Antes | Ahora |
|---|---|---|
| Entidades | 12 | 14 |
| Restricciones CHECK | 2 | 17 |
| Claves foráneas | 11 | 23 |
| Índices fuera de PK | 0 | 20 |
| Vistas | 0 | 4 |
| Triggers | 0 | 2 |
| Columnas calculadas | 0 | 1 |

Las vistas (`v_inventario_valorizado`, `v_ventas_diarias`, `v_alertas_stock`,
`v_cuadre_caja`) no suelen dibujarse en un modelo entidad-relación, pero sí
conviene mencionarlas al exponer: son las que contestan las preguntas del
negocio.
