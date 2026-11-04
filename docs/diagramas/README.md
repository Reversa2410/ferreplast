# Diagramas del modelo entidad-relación

SVG sueltos del MER extendido, listos para insertar en diapositivas, documentos
o para imprimir.

## Archivos

| Archivo | Qué muestra | Lienzo |
|---|---|---|
| `00-modelo-completo.svg` | Las 12 entidades y las 22 relaciones en un solo diagrama, con la jerarquía ISA desplegada y leyenda incluida | 1840 × 1240 |
| `01-vista-estructura.svg` | Negocio, tiendas, usuarios, categorías, productos, stock y dispositivos | 1180 × 760 |
| `02-vista-operacion.svg` | Ventas, líneas de venta, caja y movimientos de inventario | 1180 × 720 |
| `03-especializacion-usuario.svg` | Especialización total y disjunta de `USUARIO` (notación Chen) | 900 × 420 |
| `04-entidad-debil.svg` | `VENTA_LINEA` y su relación identificadora | 860 × 260 |
| `05-relacion-recursiva.svg` | `CATEGORIA` relacionada consigo misma | 420 × 300 |
| `06-entidad-asociativa.svg` | `STOCK` resolviendo el M:N entre tienda y producto | 420 × 300 |
| `07-atributos-derivados.svg` | El stock deducido de la suma de movimientos | 900 × 300 |
| `08-proceso-venta.svg` | El recorrido de una venta: de la tablet sin conexión a la base | — |

El `00` es el diagrama completo: sirve para imprimir en A3 o proyectar. Para
exponer conviene usar el `01` y el `02`, que son el mismo modelo partido en dos
para que se lea sin forzar la vista.

## Cómo usarlos

Son **SVG autocontenidos**: llevan los colores como atributos de presentación en
lugar de CSS, y un fondo blanco explícito. Eso hace que se vean igual en
PowerPoint, Google Slides, Word, Inkscape, Illustrator y en cualquier navegador,
sin depender de la hoja de estilos del documento web del que salieron.

Al ser vectoriales se pueden ampliar sin que se pixelen. Si el proyector no
tiene las tipografías *IBM Plex*, el texto cae a una alternativa del sistema y
el diagrama sigue siendo legible.

## Regenerarlos

Los SVG **no se editan a mano**: se generan.

```bash
node docs/diagramas/_generar.mjs     # genera los 8 archivos
node docs/diagramas/_verificar.mjs   # comprueba que esten bien
```

Fuentes:

- `_fuente-maestro.svgsrc` — el diagrama completo (`00`), escrito a mano.
- `_fuente-figuras.html` — copia del documento de presentación, de donde se
  extraen las figuras `01` a `07`.

El generador convierte las clases CSS en atributos de presentación y resuelve
las variables de color al tema claro.

## Qué comprueba el verificador

Además de que los archivos estén bien formados (sin clases sueltas, sin
variables CSS sin resolver, sin atributos duplicados, etiquetas emparejadas),
revisa la geometría del diagrama maestro:

- que ninguna caja de entidad se superponga con otra;
- que todo el contenido quepa dentro del lienzo;
- que **ningún conector atraviese una caja de entidad**, que es el fallo de
  legibilidad más difícil de detectar leyendo el código: una línea que pasa por
  encima de una entidad aparenta conectarse a ella.

El doble borde de las entidades débiles y el par cabecera/cuerpo de cada caja se
reconocen como notación deliberada, no como colisiones.
