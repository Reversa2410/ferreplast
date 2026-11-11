// =============================================================================
// Ayudas comunes de las rutas
//
// Dos cosas que toda ruta que escribe necesita y que no deberian escribirse
// cinco veces distintas: validar el cuerpo y traducir un error de la base a un
// codigo HTTP.
// =============================================================================

import { formatearErrores } from '../validacion.mjs';
import { esDuplicado, esIntegridad, reglaDeNegocio } from '../db.mjs';

/**
 * Valida y devuelve `{ datos }` o `{ error }`.
 *
 * Se devuelve el problema en lugar de responder desde aca para que la ruta
 * decida el mensaje: "datos de producto invalidos" dice mas que "datos
 * invalidos", y quien conoce el contexto es la ruta.
 */
export function leer(esquema, bruto) {
  const r = esquema.safeParse(bruto ?? {});
  return r.success ? { datos: r.data } : { error: formatearErrores(r.error) };
}

/**
 * Traduce un error de SQL Server al codigo HTTP que le corresponde.
 *
 * POR QUE NO SE DEVUELVE EL MENSAJE DE LA BASE:
 * los mensajes de SQL Server nombran tablas, columnas y restricciones. Eso es
 * un mapa de la base para quien no deberia tenerlo, y ademas no le dice nada
 * util a quien esta usando la aplicacion. La UNICA excepcion son las reglas
 * que lanzan los triggers del esquema con THROW 50001 y siguientes: esos
 * mensajes los escribimos nosotros, en castellano, para que los lea una
 * persona.
 *
 * El detalle completo siempre va al registro del servidor.
 */
export function responderError(e, respuesta, log, contexto) {
  const regla = reglaDeNegocio(e);
  if (regla) {
    // 409: la peticion estaba bien formada, pero el estado del negocio no la
    // admite (el cliente se paso del limite, el movimiento es inmutable).
    // Reintentar igual no la arreglaria; hay que cambiar algo antes.
    return respuesta.code(409).send({ error: regla.mensaje });
  }

  if (esDuplicado(e)) {
    return respuesta.code(409).send({
      error: 'ya existe un registro con ese valor; revise los campos unicos',
    });
  }

  if (esIntegridad(e)) {
    return respuesta.code(400).send({
      error: 'algun dato referenciado no existe, o un valor no es admisible',
    });
  }

  log?.error({ err: e }, contexto);
  return respuesta.code(500).send({ error: 'error interno del servidor' });
}

/**
 * La tienda sobre la que opera esta peticion.
 *
 * El empleado trabaja en la de su sesion y no puede elegir otra. El
 * administrador no tiene una, asi que la toma del cuerpo o de la consulta.
 *
 * POR QUE ESTA CENTRALIZADO: es la clase de regla que, repetida en cada ruta,
 * termina implementada de nueve maneras y una de ellas lee la tienda del
 * cuerpo tambien para el empleado -- que es exactamente el agujero que el
 * alcance por tienda existe para tapar.
 */
export function tiendaDeLaPeticion(usuario, pedida) {
  if (usuario.tienda_id != null) return usuario.tienda_id;
  return pedida == null ? null : Number(pedida);
}
