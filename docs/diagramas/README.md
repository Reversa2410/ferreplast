# Diagramas del modelo entidad-relación

SVG sueltos del MER extendido, listos para insertar en diapositivas, documentos
o para imprimir. Reflejan el modelo final de [`db/schema.sql`](../../db/schema.sql):
17 entidades, 30 relaciones y una jerarquía ISA.

## Archivos

| Archivo | Qué muestra | Lienzo |
|---|---|---|
| `00-modelo-completo.svg` | Las 17 entidades y las 30 relaciones en un solo diagrama, con la jerarquía ISA desplegada y leyenda | 2300 × 1400 |
| `01-vista-estructura.svg` | Negocio, tiendas, catálogo, stock, usuarios y clientes | 1820 × 720 |
| `02-vista-operacion.svg` | Ventas, líneas, caja, crédito, abonos y movimientos de inventario | 1820 × 1000 |
| `03-especializacion-usuario.svg` | Especialización total y disjunta de `USUARIO` en administrador y empleado | 920 × 470 |
| `04-entidad-debil.svg` | `VENTA_LINEA` y su relación identificadora | 1000 × 290 |
| `05-relacion-recursiva.svg` | `CATEGORIA` relacionada consigo misma | 520 × 300 |
| `06-entidad-asociativa.svg` | `STOCK` y `USUARIO_TIENDA` resolviendo sus M:N | 960 × 560 |
| `07-atributos-derivados.svg` | El stock y el saldo del cliente, calculados en vez de guardados | 960 × 510 |
| `08-proceso-venta.svg` | El recorrido de una venta: de la tablet sin conexión a la base | 1140 × 500 |
| `09-vista-acceso.svg` | Sesiones, intentos de ingreso, tablets y su bitácora | 1500 × 700 |
| `10-modelo-relacional.svg` | Las 17 tablas con todas sus columnas, tipos y claves, leídas de `db/schema.sql` | 2680 × 1640 |

El `00` es el diagrama completo: sirve para imprimir en A3 o proyectar. Para
exponer conviene usar el `01`, el `02` y el `09`, que son el mismo modelo
partido en tres para que se lea sin forzar la vista. El documento de
presentación (`docs/word/`) incluye el `08`, el `00`, el `01`, el `02`, el `09` y el `10`.

El `10` sirve para imprimir en A3; abierto en el navegador se puede guardar como
PDF.

`modelo relacional 2.svg` y `.png`, `MR.pdf` y `BDOO.pdf` son exportaciones de
Lucidchart de una versión anterior del modelo. No salen de este generador y no
reflejan el modelo final: el modelo relacional vigente es el `10`.

## Cómo usarlos

Son **SVG autocontenidos**: llevan los colores como atributos de presentación en
lugar de CSS, y un fondo blanco explícito. Se ven igual en PowerPoint, Google
Slides, Word, Inkscape, Illustrator y en cualquier navegador.

Al ser vectoriales se pueden ampliar sin que se pixelen. Si el equipo no tiene
las tipografías *IBM Plex*, el texto usa una alternativa del sistema y el
diagrama sigue siendo legible.

## Regenerarlos

Los SVG **no se editan a mano**: se generan.

```bash
npm run diagramas
```

Genera los once archivos y los verifica. Fuentes:

- `_esquema.mjs` — lee `db/schema.sql`: tablas, columnas, tipos, claves
  primarias, foráneas y únicas. El `10` y el diccionario de datos del Word
  salen de acá, así que no pueden describir una tabla distinta de la real.
- `_figuras.mjs` — el modelo (atributos de cada entidad y una relación por
  clave foránea) y dónde va cada caja en cada vista. **Si cambia una tabla, se
  cambia acá.**
- `_dibujo.mjs` — cajas, conectores y rótulos. Los recorridos de las líneas no
  se escriben: los calcula un A* sobre una grilla de 10 px que no puede
  atravesar entidades ni montarse sobre otra línea, y cada rótulo se coloca
  donde no pise nada.
- `_fuente-proceso-venta.svgsrc` — el `08`, escrito a mano.

Antes de dibujar, el generador compara el MER con el esquema: si una tabla o
una clave foránea está en uno y no en el otro, no escribe ningún diagrama.

Si una vista queda tan apretada que un conector o un rótulo no encuentran lugar,
el generador se niega a escribir el archivo. Con `DIAGRAMAS_BORRADOR=1` lo
escribe igual y avisa qué falló, para poder ver dónde mover las cajas.

## Qué comprueba el verificador

En todos los archivos: que estén bien formados (sin clases sueltas, sin
variables CSS sin resolver, sin atributos duplicados, etiquetas emparejadas) y
que ningún marcador use `orient="auto-start-reverse"`. Ese valor de SVG 2 no lo
entiende resvg, que es el que rasteriza para el Word, y dejaba todas las flechas
apuntando a la derecha: las que llegaban desde arriba quedaban tapadas por la
caja.

En el `00`, el `01`, el `02`, el `09` y el `10`, además:

- que ninguna caja de entidad se superponga con otra;
- que todo quepa dentro del lienzo;
- que **ningún conector atraviese una entidad**: una línea que pasa por encima
  de una caja parece unirse a ella;
- que **ningún rótulo quede encima de una línea**, a medias sobre una caja o
  encima de otro rótulo.

Las dos últimas comprobaciones se probaron contra los diagramas anteriores, que
tenían esos defectos, y los detectan.
