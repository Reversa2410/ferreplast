// =============================================================================
// Validacion de las cargas que envian las tablets y el panel
//
// Los datos llegan de dispositivos que estuvieron sin conexion, posiblemente
// con una version vieja de la app. Antes de tocar la base hay que comprobar que
// tengan sentido.
//
// La base tambien valida (restricciones CHECK, claves foraneas). Es a
// proposito: aca se rechaza temprano y con un mensaje entendible, y la base
// queda como ultima linea de defensa por si la API tiene un error.
// =============================================================================

import { z } from 'zod';

export const TIPOS_MOVIMIENTO = ['entrada', 'venta', 'devolucion', 'merma', 'ajuste'];
export const METODOS_PAGO = ['efectivo', 'tarjeta', 'transferencia', 'credito', 'otro'];
export const METODOS_ABONO = ['efectivo', 'tarjeta', 'transferencia', 'otro'];
export const ROLES = ['empleado', 'administrador'];

// -----------------------------------------------------------------------------
// Piezas comunes
// -----------------------------------------------------------------------------

// Identificador de fila. Desde la migracion a SQL Server las claves primarias
// son INT IDENTITY, no UUID: las asigna la base, no el cliente.
const id = () => z.number().int().positive();

// Igual, pero para lo que llega por la URL o la cadena de consulta, donde todo
// es texto. z.coerce convierte "7" en 7; sin esto, cada ruta tendria que
// acordarse de llamar a Number(), y olvidarselo no falla: compara un texto
// contra un INT y la base hace la conversion sola... hasta que no puede.
const idDeUrl = () => z.coerce.number().int().positive();

// Clave de idempotencia que genera el dispositivo.
//
// POR QUE SIGUE SIENDO UN UUID CUANDO LAS CLAVES PRIMARIAS SON ENTEROS:
// la tablet tiene que poder nombrar una operacion ANTES de que el servidor la
// conozca, para poder reintentar el envio sin duplicarla. Un entero que asigna
// la base no sirve para eso. Van a parar a la columna uuid_externo, que tiene
// un indice unico filtrado.
//
// Se usa z.guid() y NO z.uuid(). En zod 4, z.uuid() exige que los bits de
// version y variante sean los de una version RFC concreta; z.guid() solo
// verifica el formato 8-4-4-4-12 en hexadecimal. La diferencia importa:
// UNIQUEIDENTIFIER de SQL Server acepta cualquier valor bien formado, sin
// mirar la version. Si la API fuera mas estricta que la base, rechazaria
// identificadores que la base considera perfectamente validos.
const uuid = () => z.guid();

// Importe en cordobas. La base usa DECIMAL(18,2).
const importe = () => z.number().nonnegative().finite();

// Redondeo a 2 decimales para comparar importes sin arrastrar el error binario
// de los numeros de punto flotante (0.1 + 0.2 !== 0.3).
const dosDecimales = (n) => Math.round(n * 100) / 100;

// -----------------------------------------------------------------------------
// Movimiento de inventario suelto (entrada de mercaderia, merma, ajuste).
// Los movimientos por venta NO se envian: los deriva el servidor a partir de
// las lineas de la venta.
// -----------------------------------------------------------------------------
export const EsquemaMovimiento = z.object({
  // Generado por la tablet: es la clave de la idempotencia.
  uuid_externo: uuid(),
  tienda_id: id(),
  producto_id: id(),
  usuario_id: id().nullish(),
  tipo: z.enum(TIPOS_MOVIMIENTO),
  cantidad: z.number().finite().refine((n) => n !== 0, 'la cantidad no puede ser cero'),
  costo_unitario: importe().nullish(),
  motivo: z.string().max(255).nullish(),
  ocurrido_en: z.iso.datetime({ offset: true }),
})
  // El signo debe coincidir con el tipo. La base tambien lo exige; aca el
  // mensaje explica que se hizo mal en lugar de devolver un error de SQL.
  .refine(
    (m) => !(['entrada', 'devolucion'].includes(m.tipo) && m.cantidad <= 0),
    { message: 'una entrada o devolucion debe tener cantidad positiva', path: ['cantidad'] },
  )
  .refine(
    (m) => !(['venta', 'merma'].includes(m.tipo) && m.cantidad >= 0),
    { message: 'una venta o merma debe tener cantidad negativa', path: ['cantidad'] },
  )
  // 'venta' queda fuera de lo que se puede enviar como movimiento suelto: esos
  // los deriva el servidor de las lineas. Aceptarlos permitiria descontar stock
  // sin una venta detras, que es justo lo que el modelo evita.
  .refine(
    (m) => m.tipo !== 'venta',
    { message: 'los movimientos de venta los genera el servidor, no se envian', path: ['tipo'] },
  );

// -----------------------------------------------------------------------------
// Linea de venta
//
// El descuento es la rebaja por mayoreo que negocia el empleado. Va en la
// LINEA y no en la cabecera porque se negocia sobre un articulo concreto
// ("llevo doce sacos de cemento, me los deja mas baratos"), no sobre el total.
// -----------------------------------------------------------------------------
export const EsquemaLineaVenta = z.object({
  producto_id: id(),
  cantidad: z.number().positive().finite(),
  precio_unitario: importe(),
  costo_unitario: importe().default(0),
  descuento: importe().default(0),
  subtotal: importe(),
})
  .refine(
    (l) => dosDecimales(l.descuento) <= dosDecimales(l.cantidad * l.precio_unitario),
    { message: 'la rebaja no puede superar el importe de la linea', path: ['descuento'] },
  )
  // La tablet ya calculo este numero para mostrarselo al cliente. Se comprueba
  // contra la aritmetica del servidor: si no coinciden, el ticket que firmo el
  // cliente dice algo distinto de lo que se guardaria, y eso hay que frenarlo
  // antes de que entre a la base.
  .refine(
    (l) => dosDecimales(l.cantidad * l.precio_unitario) - dosDecimales(l.descuento)
        === dosDecimales(l.subtotal),
    { message: 'el subtotal de la linea no coincide con cantidad x precio menos rebaja', path: ['subtotal'] },
  );

// -----------------------------------------------------------------------------
// Venta completa, con sus lineas.
//
// El servidor deriva de aca los movimientos de inventario. La tablet no los
// envia: asi es imposible que exista una venta sin su descuento de stock.
//
// `numero` NO viene del cliente. Lo asigna el servidor, porque es unico por
// tienda (UQ_VENTA_NUMERO) y dos tablets sin conexion en el mismo local
// elegirian el mismo: la segunda venta en llegar seria rechazada por un
// problema que el vendedor no puede entender ni arreglar.
// -----------------------------------------------------------------------------
export const EsquemaVenta = z.object({
  uuid_externo: uuid(),
  tienda_id: id(),
  usuario_id: id().nullish(),
  caja_id: id().nullish(),
  cliente_id: id().nullish(),
  metodo_pago: z.enum(METODOS_PAGO).default('efectivo'),
  subtotal: importe(),
  descuento: importe().default(0),
  total: importe(),
  observaciones: z.string().nullish(),
  ocurrido_en: z.iso.datetime({ offset: true }),
  lineas: z.array(EsquemaLineaVenta).min(1, 'una venta necesita al menos una linea'),
})
  .refine(
    (v) => dosDecimales(v.total) === dosDecimales(v.subtotal - v.descuento),
    { message: 'el total no coincide con subtotal menos descuento', path: ['total'] },
  )
  // La cabecera se deriva de las lineas: el subtotal es el importe bruto y el
  // descuento es la suma de las rebajas. Se comprueba, no se recalcula en
  // silencio, por lo mismo que en la linea.
  .refine(
    (v) => dosDecimales(v.lineas.reduce((a, l) => a + dosDecimales(l.cantidad * l.precio_unitario), 0))
        === dosDecimales(v.subtotal),
    { message: 'la suma bruta de las lineas no coincide con el subtotal', path: ['subtotal'] },
  )
  .refine(
    (v) => dosDecimales(v.lineas.reduce((a, l) => a + l.descuento, 0)) === dosDecimales(v.descuento),
    { message: 'la suma de las rebajas de las lineas no coincide con el descuento', path: ['descuento'] },
  )
  // La base exige lo mismo (CK_VENTA_CLIENTE_CREDITO). Aca el mensaje dice que
  // falta, en lugar de nombrar una restriccion.
  .refine(
    (v) => v.metodo_pago !== 'credito' || v.cliente_id != null,
    { message: 'una venta al credito necesita saber a quien se le fio', path: ['cliente_id'] },
  )
  // Un mismo producto no puede aparecer dos veces (UQ_LINEA_PRODUCTO): si el
  // cliente lleva mas, va en la cantidad. Sin esto el rechazo lo daria la base,
  // con un mensaje que nombra el indice.
  .refine(
    (v) => new Set(v.lineas.map((l) => l.producto_id)).size === v.lineas.length,
    { message: 'un producto no puede repetirse en dos lineas; sume la cantidad', path: ['lineas'] },
  );

// -----------------------------------------------------------------------------
// Carga completa de sincronizacion (push)
//
// Se aceptan lotes de hasta 500 elementos. El limite existe para que una tablet
// que estuvo una semana sin conexion envie varios lotes chicos en lugar de uno
// gigante que puede cortarse a la mitad y tener que reintentarse entero.
// -----------------------------------------------------------------------------
export const EsquemaSincronizacion = z.object({
  dispositivo_id: id().nullish(),
  movimientos: z.array(EsquemaMovimiento).max(500).default([]),
  ventas: z.array(EsquemaVenta).max(500).default([]),
});

// -----------------------------------------------------------------------------
// Credenciales de ingreso
// -----------------------------------------------------------------------------

// Ingreso del administrador: email y contrasenia, desde el panel web.
//
// El minimo de 8 caracteres se exige al CREAR la contrasenia, no al usarla:
// aca se acepta cualquier cosa no vacia. Si alguien tiene una clave vieja mas
// corta tiene que poder entrar para cambiarla; rechazarla en el ingreso la
// dejaria afuera de su propia cuenta.
export const EsquemaLoginAdmin = z.object({
  email: z.email().max(150),
  password: z.string().min(1).max(200),
});

// Ingreso del empleado: elige su tienda, su nombre de una lista, y teclea el PIN.
//
// Se manda usuario_id y no el nombre porque dos empleados pueden llamarse
// igual, y porque el nombre cambia (se corrige un error de tipeo) mientras que
// el identificador no.
//
// tienda_id es obligatorio porque un empleado puede estar asignado a las dos
// tiendas (tabla USUARIO_TIENDA). Se decide AL ENTRAR y queda grabado en la
// sesion: todo lo que haga en ese turno pertenece a esa tienda, sin que cada
// peticion tenga que decirlo (y sin que pueda mentir al respecto).
export const EsquemaLoginPin = z.object({
  usuario_id: id(),
  tienda_id: id(),
  pin: z.string().regex(/^\d{4,8}$/, 'el PIN son de 4 a 8 digitos'),
  dispositivo_id: id().nullish(),
});

// Cambio de clave propia. Aca SI se exige una contrasenia decente, porque es
// el momento en que se elige.
export const EsquemaCambioPassword = z.object({
  actual: z.string().min(1).max(200),
  nueva: z.string().min(8, 'la contrasenia necesita al menos 8 caracteres').max(200),
});

export const EsquemaCambioPin = z.object({
  actual: z.string().regex(/^\d{4,8}$/, 'el PIN son de 4 a 8 digitos'),
  nuevo: z.string().regex(/^\d{4,8}$/, 'el PIN son de 4 a 8 digitos'),
});

// -----------------------------------------------------------------------------
// Parametros de URL
// -----------------------------------------------------------------------------
export const EsquemaIdEnUrl = z.object({ id: idDeUrl() });
export const EsquemaTiendaEnUrl = z.object({ tiendaId: idDeUrl() });
export const EsquemaProductoEnUrl = z.object({ productoId: idDeUrl() });

/**
 * Convierte los errores de zod en una lista plana y legible.
 */
export function formatearErrores(error) {
  return error.issues.map((i) => ({
    campo: i.path.join('.') || '(raiz)',
    mensaje: i.message,
  }));
}
