// =============================================================================
// Catalogo: productos, categorias y movimientos de inventario a mano
//
// POR QUE ESTE ES EL PRIMER ENDPOINT DE ESCRITURA QUE HACIA FALTA:
// hasta ahora lo unico que escribia era /sync/push, que recibe ventas y
// movimientos. No habia forma de dar de alta un producto. Y el levantamiento
// dice que la duenia "desconoce por completo la cantidad de productos" y que la
// mercaderia "no viene con ninguna clase de codigo": cargar el catalogo es la
// primera tarea real del sistema, y sin esto habia que hacerla con INSERT a
// mano.
//
// QUIEN PUEDE QUE:
//   * Leer el catalogo: cualquiera con sesion. La pantalla de venta lo necesita.
//   * Crear y modificar productos: solo el administrador. Un precio es plata.
//   * Entradas y mermas: el empleado, en su tienda. Recibe la mercaderia y ve
//     romperse las cosas; es quien tiene el dato.
//   * Ajustes de inventario: solo el administrador. Un ajuste es la unica
//     operacion que puede hacer desaparecer mercaderia sin dejar una venta
//     detras, asi que es la que no puede quedar en manos del mostrador.
// =============================================================================

import {
  EsquemaProductoNuevo,
  EsquemaProductoCambio,
  EsquemaCategoriaNueva,
  EsquemaStockMinimo,
  EsquemaMovimientoManual,
  EsquemaIdEnUrl,
} from '../validacion.mjs';
import { exigirRol, puedeOperarEn, ADMIN } from '../auth/guardia.mjs';
import { insertarMovimiento } from '../dominio/ventas.mjs';
import { leer, responderError, tiendaDeLaPeticion } from './_ayudas.mjs';

// Techo de filas por pagina. Con cientos de productos el listado completo es
// razonable; el limite existe para que el dia que sean decenas de miles la
// respuesta no crezca sin control.
const POR_PAGINA = 200;

export default async function rutasCatalogo(app, { db }) {
  // ---------------------------------------------------------------------------
  // GET /categorias
  // ---------------------------------------------------------------------------
  app.get('/categorias', async () => {
    const { rows } = await db.query(
      `SELECT c.id, c.nombre, c.padre_id, p.nombre AS padre,
              (SELECT COUNT(*) FROM PRODUCTO x
                WHERE x.categoria_id = c.id AND x.activo = 1) AS productos
         FROM CATEGORIA c
         LEFT JOIN CATEGORIA p ON p.id = c.padre_id
        ORDER BY c.nombre`,
    );
    return { categorias: rows };
  });

  // ---------------------------------------------------------------------------
  // POST /categorias                      [administrador]
  // ---------------------------------------------------------------------------
  app.post('/categorias', { preHandler: exigirRol(ADMIN) }, async (peticion, respuesta) => {
    const { datos, error } = leer(EsquemaCategoriaNueva, peticion.body);
    if (error) return respuesta.code(400).send({ error: 'datos de categoria invalidos', detalles: error });

    try {
      const { rows } = await db.query(
        `DECLARE @nueva TABLE (id INT);
         INSERT INTO CATEGORIA (nombre, padre_id)
         OUTPUT INSERTED.id INTO @nueva
         VALUES (@nombre, @padre_id);
         SELECT id FROM @nueva;`,
        { nombre: datos.nombre, padre_id: datos.padre_id ?? null },
      );
      return respuesta.code(201).send({ id: rows[0].id, nombre: datos.nombre });
    } catch (e) {
      return responderError(e, respuesta, peticion.log, 'fallo al crear la categoria');
    }
  });

  // ---------------------------------------------------------------------------
  // GET /productos
  //
  // El buscador del mostrador. `q` busca por nombre o por codigo porque el
  // empleado tiene el articulo en la mano: a veces lee la etiqueta y a veces
  // solo sabe como se llama.
  //
  // Devuelve el stock de la tienda que corresponde: la del empleado por su
  // sesion, o la que pida el administrador. Sin tienda no trae stock, que es lo
  // correcto para el panel cuando mira el catalogo en general.
  // ---------------------------------------------------------------------------
  app.get('/productos', async (peticion) => {
    const { q = null, categoria_id = null, incluir_inactivos = null } = peticion.query;
    const tiendaId = tiendaDeLaPeticion(peticion.usuario, peticion.query.tienda_id);
    const pagina = Math.max(1, Number(peticion.query.pagina) || 1);

    const { rows } = await db.query(
      `SELECT p.id, p.codigo, p.nombre, p.categoria_id, c.nombre AS categoria,
              p.precio_costo, p.precio_venta, p.unidad_medida, p.activo,
              s.cantidad        AS stock,
              s.cantidad_minima AS stock_minimo
         FROM PRODUCTO  p
         JOIN CATEGORIA c ON c.id = p.categoria_id
         LEFT JOIN Stock s
                ON s.producto_id = p.id
               AND s.tienda_id   = @tienda_id
        WHERE (@incluir_inactivos = 1 OR p.activo = 1)
          AND (@categoria_id IS NULL OR p.categoria_id = @categoria_id)
          AND (@q IS NULL
               OR p.nombre LIKE '%' + @q + '%'
               OR p.codigo LIKE '%' + @q + '%')
        ORDER BY p.nombre
        OFFSET @salto ROWS FETCH NEXT @toma ROWS ONLY`,
      {
        tienda_id: tiendaId,
        q: q || null,
        categoria_id: categoria_id === null ? null : Number(categoria_id),
        incluir_inactivos: incluir_inactivos === '1' ? 1 : 0,
        salto: (pagina - 1) * POR_PAGINA,
        toma: POR_PAGINA,
      },
    );

    return { pagina, por_pagina: POR_PAGINA, tienda_id: tiendaId, productos: rows };
  });

  // ---------------------------------------------------------------------------
  // GET /productos/:id
  // ---------------------------------------------------------------------------
  app.get('/productos/:id', async (peticion, respuesta) => {
    const params = leer(EsquemaIdEnUrl, peticion.params);
    if (params.error) return respuesta.code(400).send({ error: 'identificador invalido' });

    const { rows } = await db.query(
      `SELECT p.id, p.codigo, p.nombre, p.categoria_id, c.nombre AS categoria,
              p.precio_costo, p.precio_venta, p.unidad_medida, p.activo,
              p.created_at, p.updated_at
         FROM PRODUCTO  p
         JOIN CATEGORIA c ON c.id = p.categoria_id
        WHERE p.id = @id`,
      { id: params.datos.id },
    );
    if (rows.length === 0) return respuesta.code(404).send({ error: 'producto no encontrado' });

    // El stock de las DOS tiendas: es lo que la duenia quiere ver de un
    // producto, y es justamente la pregunta que hoy la obliga a caminar hasta
    // la otra esquina.
    const { rows: stock } = await db.query(
      `SELECT t.id AS tienda_id, t.nombre AS tienda,
              ISNULL(s.cantidad, 0)        AS cantidad,
              ISNULL(s.cantidad_minima, 0) AS cantidad_minima
         FROM TIENDA t
         LEFT JOIN Stock s ON s.tienda_id = t.id AND s.producto_id = @id
        WHERE t.activo = 1
        ORDER BY t.nombre`,
      { id: params.datos.id },
    );

    return { producto: rows[0], stock };
  });

  // ---------------------------------------------------------------------------
  // POST /productos                       [administrador]
  // ---------------------------------------------------------------------------
  app.post('/productos', { preHandler: exigirRol(ADMIN) }, async (peticion, respuesta) => {
    const { datos, error } = leer(EsquemaProductoNuevo, peticion.body);
    if (error) return respuesta.code(400).send({ error: 'datos de producto invalidos', detalles: error });

    try {
      const { rows } = await db.query(
        `DECLARE @nuevo TABLE (id INT);
         INSERT INTO PRODUCTO (codigo, nombre, categoria_id, precio_costo,
                               precio_venta, unidad_medida)
         OUTPUT INSERTED.id INTO @nuevo
         VALUES (@codigo, @nombre, @categoria_id, @precio_costo,
                 @precio_venta, @unidad_medida);
         SELECT id FROM @nuevo;`,
        {
          codigo: datos.codigo ?? null,
          nombre: datos.nombre,
          categoria_id: datos.categoria_id,
          precio_costo: datos.precio_costo,
          precio_venta: datos.precio_venta,
          unidad_medida: datos.unidad_medida,
        },
      );
      return respuesta.code(201).send({ id: rows[0].id, ...datos });
    } catch (e) {
      return responderError(e, respuesta, peticion.log, 'fallo al crear el producto');
    }
  });

  // ---------------------------------------------------------------------------
  // PATCH /productos/:id                  [administrador]
  //
  // Se usa PATCH y no PUT porque lo normal es corregir un precio, no reenviar
  // el producto entero: con PUT, un cliente que omita un campo lo borraria.
  //
  // NO existe DELETE. Un producto vendido esta referenciado por sus lineas de
  // venta, asi que borrarlo romperia el historial -- y el historial es la razon
  // por la que existe el sistema. Darlo de baja es `activo: false`: desaparece
  // del mostrador y sigue explicando las ventas viejas.
  // ---------------------------------------------------------------------------
  app.patch('/productos/:id', { preHandler: exigirRol(ADMIN) }, async (peticion, respuesta) => {
    const params = leer(EsquemaIdEnUrl, peticion.params);
    if (params.error) return respuesta.code(400).send({ error: 'identificador invalido' });

    const { datos, error } = leer(EsquemaProductoCambio, peticion.body);
    if (error) return respuesta.code(400).send({ error: 'datos de producto invalidos', detalles: error });

    // Cada campo se actualiza solo si vino. El patron ISNULL(@x, columna) no
    // sirve: no distingue "no lo mandaron" de "lo mandaron en null", y el
    // codigo de un producto SE PUEDE querer borrar.
    const partes = [];
    const params2 = { id: params.datos.id };
    for (const campo of ['nombre', 'categoria_id', 'precio_costo', 'precio_venta',
      'unidad_medida', 'codigo', 'activo']) {
      if (campo in datos) {
        partes.push(`${campo} = @${campo}`);
        params2[campo] = campo === 'activo' ? (datos[campo] ? 1 : 0) : datos[campo] ?? null;
      }
    }

    try {
      const { rowCount } = await db.query(
        `UPDATE PRODUCTO
            SET ${partes.join(', ')}, updated_at = SYSUTCDATETIME()
          WHERE id = @id`,
        params2,
      );
      if (rowCount === 0) return respuesta.code(404).send({ error: 'producto no encontrado' });
      return { actualizado: true, campos: Object.keys(datos) };
    } catch (e) {
      return responderError(e, respuesta, peticion.log, 'fallo al modificar el producto');
    }
  });

  // ---------------------------------------------------------------------------
  // PUT /productos/:id/stock-minimo       [administrador]
  //
  // El minimo de reposicion es POR TIENDA: la ferreteria y la plastiqueria
  // rotan distinto, y el numero que dispara la alerta tiene que reflejarlo.
  //
  // Es un MERGE porque la fila de Stock puede no existir todavia: un producto
  // recien creado no tiene stock en ninguna tienda hasta la primera entrada, y
  // poder fijarle el minimo antes de recibirlo es justamente lo util.
  // ---------------------------------------------------------------------------
  app.put('/productos/:id/stock-minimo', { preHandler: exigirRol(ADMIN) }, async (peticion, respuesta) => {
    const params = leer(EsquemaIdEnUrl, peticion.params);
    if (params.error) return respuesta.code(400).send({ error: 'identificador invalido' });

    const { datos, error } = leer(EsquemaStockMinimo, peticion.body);
    if (error) return respuesta.code(400).send({ error: 'datos invalidos', detalles: error });

    try {
      await db.query(
        `MERGE Stock AS destino
         USING (SELECT @tienda_id AS tienda_id, @producto_id AS producto_id) AS fuente
            ON destino.tienda_id = fuente.tienda_id
           AND destino.producto_id = fuente.producto_id
         WHEN MATCHED THEN
             UPDATE SET cantidad_minima = CAST(@minimo AS DECIMAL(18,3)),
                        updated_at = SYSUTCDATETIME()
         WHEN NOT MATCHED THEN
             INSERT (tienda_id, producto_id, cantidad, cantidad_minima)
             VALUES (@tienda_id, @producto_id, 0, CAST(@minimo AS DECIMAL(18,3)));`,
        {
          tienda_id: datos.tienda_id,
          producto_id: params.datos.id,
          minimo: datos.cantidad_minima,
        },
      );
      return { actualizado: true };
    } catch (e) {
      return responderError(e, respuesta, peticion.log, 'fallo al fijar el stock minimo');
    }
  });

  // ---------------------------------------------------------------------------
  // POST /inventario/movimientos
  //
  // Entrada de mercaderia, merma o ajuste, registrado a mano.
  //
  // Es la contraparte de /sync/push para cuando hay conexion, y NO lleva
  // uuid_externo: se registra desde una pantalla con la respuesta a la vista,
  // asi que nadie lo va a reenviar a ciegas.
  // ---------------------------------------------------------------------------
  app.post('/inventario/movimientos', async (peticion, respuesta) => {
    const { datos, error } = leer(EsquemaMovimientoManual, peticion.body);
    if (error) return respuesta.code(400).send({ error: 'datos de movimiento invalidos', detalles: error });

    if (!puedeOperarEn(peticion.usuario, datos.tienda_id)) {
      return respuesta.code(403).send({ error: 'no puede mover inventario de esa tienda' });
    }

    // El ajuste es la unica operacion que puede hacer desaparecer mercaderia
    // sin una venta detras. Queda para el administrador.
    if (datos.tipo === 'ajuste' && peticion.usuario.rol !== ADMIN) {
      return respuesta.code(403).send({
        error: 'un ajuste de inventario lo registra el administrador',
      });
    }

    try {
      const resultado = await db.tx(async (tx) => {
        // Lo que RESTA (merma, ajuste negativo) no puede llevarse mas de lo que
        // hay: el stock quedaria en negativo, que no significa nada. Mismo
        // criterio y mismo bloqueo que la venta con conexion (seccion 30 de las
        // pruebas): UPDLOCK + HOLDLOCK hace que dos bajas simultaneas del
        // ultimo articulo no pasen las dos.
        //
        // Por /sync/push no se exige, a proposito: lo roto sin senial ya se
        // rompio, y rechazarlo solo lo borraria del registro.
        if (datos.cantidad < 0) {
          const { rows } = await tx.query(
            `SELECT p.nombre, p.unidad_medida, ISNULL(s.cantidad, 0) AS hay
               FROM PRODUCTO p
               LEFT JOIN Stock s WITH (UPDLOCK, HOLDLOCK)
                      ON s.producto_id = p.id AND s.tienda_id = @t
              WHERE p.id = @p`,
            { t: datos.tienda_id, p: datos.producto_id },
          );
          const hay = Number(rows[0]?.hay ?? 0);
          if (-datos.cantidad > hay) {
            return { faltante: { producto_id: datos.producto_id, nombre: rows[0]?.nombre ?? '',
                                 unidad: rows[0]?.unidad_medida ?? '', pedida: -datos.cantidad,
                                 hay: Math.max(0, hay) } };
          }
        }
        await insertarMovimiento(tx, {
          ...datos,
          usuario_id: peticion.usuario.id,
          ocurrido_en: null,   // lo pone el servidor: esto esta pasando ahora
        });
        const { rows } = await tx.query(
          'SELECT cantidad FROM Stock WHERE tienda_id = @t AND producto_id = @p',
          { t: datos.tienda_id, p: datos.producto_id },
        );
        return { stock: Number(rows[0]?.cantidad ?? 0) };
      });

      if (resultado.faltante) {
        const f = resultado.faltante;
        return respuesta.code(409).send({
          error: `no hay existencia suficiente. ${f.nombre}: pidio dar de baja ${f.pedida}, hay ${f.hay}${f.unidad ? ` ${f.unidad}` : ''}`,
          faltantes: [f],
        });
      }
      return respuesta.code(201).send({ registrado: true, stock_resultante: resultado.stock });
    } catch (e) {
      return responderError(e, respuesta, peticion.log, 'fallo al registrar el movimiento');
    }
  });
}
