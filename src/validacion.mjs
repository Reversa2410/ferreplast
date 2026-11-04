// =============================================================================
// Validacion de las cargas que envian las tablets
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

// Identificador UUID.
//
// Se usa z.guid() y NO z.uuid(). En zod 4, z.uuid() exige que los bits de
// version y variante sean los de una version RFC concreta; z.guid() solo
// verifica el formato 8-4-4-4-12 en hexadecimal.
//
// La diferencia importa: PostgreSQL acepta como uuid cualquier valor bien
// formado, sin mirar la version. Si la API fuera mas estricta que la base,
// rechazaria identificadores que la base considera perfectamente validos
// -- por ejemplo los UUID legibles de los datos de prueba, o los de cualquier
// sistema externo cuyos identificadores haya que importar algun dia.
// La validacion debe coincidir con lo que el almacenamiento admite.
const uuid = () => z.guid();

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
  id:             uuid(),
  tienda_id:      uuid(),
  producto_id:    uuid(),
  usuario_id:     uuid().nullish(),
  tipo:           z.enum(TIPOS_MOVIMIENTO),
  cantidad:       z.number().finite().refine((n) => n !== 0, 'la cantidad no puede ser cero'),
  costo_unitario: z.number().nonnegative().nullish(),
  motivo:         z.string().max(255).nullish(),
  ocurrido_en:    z.iso.datetime({ offset: true }),
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
  );

// -----------------------------------------------------------------------------
// Linea de venta
// -----------------------------------------------------------------------------
export const EsquemaLineaVenta = z.object({
  producto_id:     uuid(),
  cantidad:        z.number().positive(),
  precio_unitario: z.number().nonnegative(),
  costo_unitario:  z.number().nonnegative().default(0),
  subtotal:        z.number().nonnegative(),
}).refine(
  (l) => dosDecimales(l.cantidad * l.precio_unitario) === dosDecimales(l.subtotal),
  { message: 'el subtotal de la linea no coincide con cantidad x precio', path: ['subtotal'] },
);

// -----------------------------------------------------------------------------
// Venta completa, con sus lineas.
//
// El servidor deriva de aca los movimientos de inventario. La tablet no los
// envia: asi es imposible que exista una venta sin su descuento de stock.
// -----------------------------------------------------------------------------
export const EsquemaVenta = z.object({
  id:            uuid(),
  tienda_id:     uuid(),
  usuario_id:    uuid().nullish(),
  caja_id:       uuid().nullish(),
  numero:        z.string().min(1).max(30),
  subtotal:      z.number().nonnegative(),
  descuento:     z.number().nonnegative().default(0),
  total:         z.number().nonnegative(),
  metodo_pago:   z.enum(METODOS_PAGO).default('efectivo'),
  observaciones: z.string().nullish(),
  ocurrido_en:   z.iso.datetime({ offset: true }),
  lineas:        z.array(EsquemaLineaVenta).min(1, 'una venta necesita al menos una linea'),
})
  .refine(
    (v) => dosDecimales(v.total) === dosDecimales(v.subtotal - v.descuento),
    { message: 'el total no coincide con subtotal menos descuento', path: ['total'] },
  )
  .refine(
    (v) => dosDecimales(v.lineas.reduce((a, l) => a + l.subtotal, 0)) === dosDecimales(v.subtotal),
    { message: 'la suma de las lineas no coincide con el subtotal', path: ['subtotal'] },
  );

// -----------------------------------------------------------------------------
// Carga completa de sincronizacion (push)
//
// Se aceptan lotes de hasta 500 elementos. El limite existe para que una tablet
// que estuvo una semana sin conexion envie varios lotes chicos en lugar de uno
// gigante que puede cortarse a la mitad y tener que reintentarse entero.
// -----------------------------------------------------------------------------
export const EsquemaSincronizacion = z.object({
  dispositivo_id: uuid().nullish(),
  movimientos:    z.array(EsquemaMovimiento).max(500).default([]),
  ventas:         z.array(EsquemaVenta).max(500).default([]),
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
  email:    z.email().max(150),
  password: z.string().min(1).max(200),
});

// Ingreso del empleado: elige su nombre de una lista y teclea el PIN.
//
// Se manda usuario_id y no el nombre porque dos empleados pueden llamarse
// igual, y porque el nombre cambia (se corrige un error de tipeo) mientras que
// el identificador no.
export const EsquemaLoginPin = z.object({
  usuario_id:     uuid(),
  pin:            z.string().regex(/^\d{4,8}$/, 'el PIN son de 4 a 8 digitos'),
  dispositivo_id: uuid().nullish(),
});

// Cambio de clave propia. Aca SI se exige una contrasenia decente, porque es
// el momento en que se elige.
export const EsquemaCambioPassword = z.object({
  actual: z.string().min(1).max(200),
  nueva:  z.string().min(8, 'la contrasenia necesita al menos 8 caracteres').max(200),
});

export const EsquemaCambioPin = z.object({
  actual: z.string().regex(/^\d{4,8}$/, 'el PIN son de 4 a 8 digitos'),
  nuevo:  z.string().regex(/^\d{4,8}$/, 'el PIN son de 4 a 8 digitos'),
});

/**
 * Convierte los errores de zod en una lista plana y legible.
 */
export function formatearErrores(error) {
  return error.issues.map((i) => ({
    campo: i.path.join('.') || '(raiz)',
    mensaje: i.message,
  }));
}
