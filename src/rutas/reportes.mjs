// =============================================================================
// Reportes del panel del duenio
//
// Estas rutas se apoyan en las vistas definidas en el esquema. La logica de
// calculo vive en la base, no aca: asi el mismo numero sale igual desde la API,
// desde psql o desde cualquier herramienta de reportes que se conecte despues.
// =============================================================================

export default async function rutasReportes(app, { db }) {
  // ---------------------------------------------------------------------------
  // GET /reportes/resumen
  //
  // La pantalla principal del duenio: como va el dia en las DOS tiendas.
  // Es la consulta que hoy le exige caminar hasta la otra esquina.
  // ---------------------------------------------------------------------------
  app.get('/reportes/resumen', async (peticion) => {
    const fecha = peticion.query.fecha ?? null; // null = hoy

    const { rows: porTienda } = await db.query(
      `SELECT tienda_id, tienda, fecha, cantidad_ventas, total_vendido,
              costo_mercaderia, ganancia_bruta, ticket_promedio
         FROM v_ventas_diarias
        WHERE fecha = COALESCE($1::date, CURRENT_DATE)
        ORDER BY tienda`,
      [fecha],
    );

    const { rows: alertas } = await db.query(
      `SELECT tienda, codigo, producto, cantidad, cantidad_minima, unidad_medida
         FROM v_alertas_stock`,
    );

    const { rows: inventario } = await db.query(
      `SELECT tienda,
              SUM(valor_costo) AS valor_costo,
              SUM(valor_venta) AS valor_venta
         FROM v_inventario_valorizado
        GROUP BY tienda
        ORDER BY tienda`,
    );

    // Los importes vienen como texto desde PostgreSQL (NUMERIC se serializa asi
    // para no perder precision al convertirlo a punto flotante). El total se
    // arma sumando con Number solo para mostrarlo.
    const totalVendido = porTienda.reduce((a, t) => a + Number(t.total_vendido), 0);
    const totalGanancia = porTienda.reduce((a, t) => a + Number(t.ganancia_bruta), 0);

    return {
      fecha: fecha ?? new Date().toISOString().slice(0, 10),
      consolidado: {
        total_vendido: totalVendido,
        ganancia_bruta: totalGanancia,
        cantidad_alertas: alertas.length,
      },
      por_tienda: porTienda,
      inventario_valorizado: inventario,
      alertas_stock: alertas,
    };
  });

  // ---------------------------------------------------------------------------
  // GET /reportes/ventas
  //
  // Serie diaria para el grafico del panel, con rango de fechas opcional.
  // ---------------------------------------------------------------------------
  app.get('/reportes/ventas', async (peticion) => {
    const { desde = null, hasta = null, tienda_id = null } = peticion.query;

    const { rows } = await db.query(
      `SELECT tienda_id, tienda, fecha, cantidad_ventas, total_vendido,
              costo_mercaderia, ganancia_bruta, ticket_promedio
         FROM v_ventas_diarias
        WHERE ($1::date IS NULL OR fecha >= $1::date)
          AND ($2::date IS NULL OR fecha <= $2::date)
          AND ($3::uuid IS NULL OR tienda_id = $3::uuid)
        ORDER BY fecha DESC, tienda`,
      [desde, hasta, tienda_id],
    );
    return { ventas: rows };
  });

  // ---------------------------------------------------------------------------
  // GET /reportes/inventario
  //
  // Inventario valorizado: cuanta plata hay inmovilizada en mercaderia.
  // ---------------------------------------------------------------------------
  app.get('/reportes/inventario', async (peticion) => {
    const { tienda_id = null } = peticion.query;
    const { rows } = await db.query(
      `SELECT * FROM v_inventario_valorizado
        WHERE ($1::uuid IS NULL OR tienda_id = $1::uuid)
        ORDER BY tienda, producto`,
      [tienda_id],
    );
    return { inventario: rows };
  });

  // ---------------------------------------------------------------------------
  // GET /reportes/movimientos/:productoId
  //
  // Historial completo de un producto: la auditoria que hoy no existe. Ante una
  // diferencia en el conteo fisico, muestra que paso, cuando y quien lo hizo.
  // ---------------------------------------------------------------------------
  app.get('/reportes/movimientos/:productoId', async (peticion) => {
    const { productoId } = peticion.params;
    const { tienda_id = null, limite = 200 } = peticion.query;

    const { rows } = await db.query(
      `SELECT m.id, m.tipo, m.cantidad, m.costo_unitario, m.motivo,
              m.ocurrido_en, m.created_at, m.venta_id,
              t.nombre AS tienda, u.nombre AS usuario
         FROM movimientos_inventario m
         JOIN tiendas t ON t.id = m.tienda_id
         LEFT JOIN usuarios u ON u.id = m.usuario_id
        WHERE m.producto_id = $1
          AND ($2::uuid IS NULL OR m.tienda_id = $2::uuid)
        ORDER BY m.ocurrido_en DESC
        LIMIT $3`,
      [productoId, tienda_id, Math.min(Number(limite) || 200, 1000)],
    );
    return { movimientos: rows };
  });
}
