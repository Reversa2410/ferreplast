// =============================================================================
// Reportes del panel de la duenia
//
// Estas rutas se apoyan en las vistas definidas en el esquema. La logica de
// calculo vive en la base, no aca: asi el mismo numero sale igual desde la API,
// desde SSMS o desde cualquier herramienta de reportes que se conecte despues.
//
// NOTA SOBRE LOS IMPORTES: con PostgreSQL los NUMERIC llegaban como texto y
// habia que convertirlos. El driver de SQL Server devuelve los DECIMAL como
// numeros de JavaScript, asi que ya no hace falta.
//
// PENDIENTE -- LA FECHA DE LOS REPORTES ESTA EN UTC, NO EN HORA LOCAL.
// La vista v_ventas_diarias agrupa por CAST(ocurrido_en AS DATE), y ocurrido_en
// se guarda en UTC. Nicaragua es UTC-6, asi que una venta de las 18:30 de la
// tarde (00:30 UTC del dia siguiente) se cuenta en el dia equivocado. Para una
// ferreteria que cierra a la tarde eso desplaza las ultimas ventas de cada dia.
// El arreglo es en la vista, no aca:
//     CAST(ocurrido_en AT TIME ZONE 'UTC'
//                      AT TIME ZONE 'Central America Standard Time' AS DATE)
// Se deja anotado y no corregido porque cambia numeros que las pruebas del
// esquema ya verifican, y es una decision del modelo, no del porte.
// =============================================================================

import { exigirRol, ADMIN } from '../auth/guardia.mjs';
import { EsquemaProductoEnUrl } from '../validacion.mjs';

// Techo de filas para el historial de un producto. Existe para que una consulta
// mal armada desde el panel no intente traer el movimiento de inventario de
// varios anios en una sola respuesta.
const LIMITE_MOVIMIENTOS = 1000;

export default async function rutasReportes(app, { db }) {
  // Todas las rutas de este archivo son del panel de la duenia y consolidan las
  // DOS tiendas, asi que el rol se exige una sola vez para el conjunto.
  //
  // El hook se registra dentro de esta funcion, que es un plugin de Fastify:
  // su alcance es solo lo que se declara aca adentro. Las rutas de sync y de
  // ingreso, que estan en otros plugins, no se ven afectadas.
  app.addHook('preHandler', exigirRol(ADMIN));

  // ---------------------------------------------------------------------------
  // GET /reportes/resumen
  //
  // La pantalla principal de la duenia: como va el dia en las DOS tiendas.
  // Es la consulta que hoy le exige caminar hasta la otra esquina.
  // ---------------------------------------------------------------------------
  app.get('/reportes/resumen', async (peticion) => {
    const fecha = peticion.query.fecha ?? null; // null = hoy

    const { rows: porTienda } = await db.query(
      `SELECT tienda_id, tienda, fecha, cantidad_ventas, total_vendido,
              costo_mercaderia, ganancia_bruta, ticket_promedio
         FROM v_ventas_diarias
        WHERE fecha = ISNULL(CAST(@fecha AS DATE), CAST(SYSUTCDATETIME() AS DATE))
        ORDER BY tienda`,
      { fecha },
    );

    const { rows: alertas } = await db.query(
      `SELECT tienda, codigo, producto, cantidad, cantidad_minima, unidad_medida
         FROM v_alertas_stock
        ORDER BY tienda, producto`,
    );

    const { rows: inventario } = await db.query(
      `SELECT tienda,
              SUM(valor_costo) AS valor_costo,
              SUM(valor_venta) AS valor_venta
         FROM v_inventario_valorizado
        GROUP BY tienda
        ORDER BY tienda`,
    );

    const { rows: cobrar } = await db.query(
      `SELECT ISNULL(SUM(saldo), 0) AS saldo_total,
              SUM(CASE WHEN saldo > 0 THEN 1 ELSE 0 END) AS clientes_con_deuda
         FROM v_cuentas_por_cobrar`,
    );

    const totalVendido = porTienda.reduce((a, t) => a + Number(t.total_vendido), 0);
    const totalGanancia = porTienda.reduce((a, t) => a + Number(t.ganancia_bruta), 0);

    return {
      fecha: fecha ?? new Date().toISOString().slice(0, 10),
      consolidado: {
        total_vendido: totalVendido,
        ganancia_bruta: totalGanancia,
        cantidad_alertas: alertas.length,
        por_cobrar: Number(cobrar[0]?.saldo_total ?? 0),
        clientes_con_deuda: Number(cobrar[0]?.clientes_con_deuda ?? 0),
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
        WHERE (@desde IS NULL OR fecha >= CAST(@desde AS DATE))
          AND (@hasta IS NULL OR fecha <= CAST(@hasta AS DATE))
          AND (@tienda_id IS NULL OR tienda_id = @tienda_id)
        ORDER BY fecha DESC, tienda`,
      { desde, hasta, tienda_id: tienda_id === null ? null : Number(tienda_id) },
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
      `SELECT tienda_id, tienda, producto_id, codigo, producto, cantidad,
              cantidad_minima, precio_costo, precio_venta, valor_costo,
              valor_venta, necesita_reposicion
         FROM v_inventario_valorizado
        WHERE (@tienda_id IS NULL OR tienda_id = @tienda_id)
        ORDER BY tienda, producto`,
      { tienda_id: tienda_id === null ? null : Number(tienda_id) },
    );
    return { inventario: rows };
  });

  // ---------------------------------------------------------------------------
  // GET /reportes/movimientos/:productoId
  //
  // Historial completo de un producto: la auditoria que hoy no existe. Ante una
  // diferencia en el conteo fisico, muestra que paso, cuando y quien lo hizo.
  // ---------------------------------------------------------------------------
  app.get('/reportes/movimientos/:productoId', async (peticion, respuesta) => {
    const params = EsquemaProductoEnUrl.safeParse(peticion.params);
    if (!params.success) {
      return respuesta.code(400).send({ error: 'identificador de producto invalido' });
    }

    const { tienda_id = null, limite = 200 } = peticion.query;

    const { rows } = await db.query(
      `SELECT TOP (@limite)
              m.id, m.tipo, m.cantidad, m.costo_unitario, m.motivo,
              m.ocurrido_en, m.created_at, m.venta_id,
              t.nombre AS tienda, u.nombre AS usuario
         FROM MOVIMIENTO_INVENTARIO m
         JOIN TIENDA  t ON t.id = m.tienda_id
         LEFT JOIN Usuario u ON u.id = m.usuario_id
        WHERE m.producto_id = @producto_id
          AND (@tienda_id IS NULL OR m.tienda_id = @tienda_id)
        ORDER BY m.ocurrido_en DESC`,
      {
        producto_id: params.data.productoId,
        tienda_id: tienda_id === null ? null : Number(tienda_id),
        limite: Math.min(Number(limite) || 200, LIMITE_MOVIMIENTOS),
      },
    );
    return { movimientos: rows };
  });

  // ---------------------------------------------------------------------------
  // GET /reportes/cuentas-por-cobrar
  //
  // Quien debe y cuanto. Hasta ahora esto vivia en la memoria de la duenia y en
  // un cuaderno; es el reporte que justifica la tabla CLIENTE.
  // ---------------------------------------------------------------------------
  app.get('/reportes/cuentas-por-cobrar', async (peticion) => {
    // Por defecto solo se listan los que deben algo: la lista completa de
    // clientes es otra pantalla.
    const soloDeudores = peticion.query.todos !== '1';

    const { rows } = await db.query(
      `SELECT cliente_id, nombre, telefono, limite_credito, total_fiado,
              total_abonado, saldo, cupo_disponible, ventas_a_credito,
              ultima_venta, ultimo_abono
         FROM v_cuentas_por_cobrar
        WHERE (@solo_deudores = 0 OR saldo > 0)
        ORDER BY saldo DESC, nombre`,
      { solo_deudores: soloDeudores ? 1 : 0 },
    );

    return {
      total: rows.reduce((a, c) => a + Number(c.saldo), 0),
      clientes: rows,
    };
  });

  // ---------------------------------------------------------------------------
  // GET /reportes/cuadre-caja
  //
  // Lo contado contra lo esperado, por caja. La columna `cuadra` es la que
  // interesa: dice si la diferencia que registro el empleado al cerrar coincide
  // con la que sale de las ventas y los abonos.
  // ---------------------------------------------------------------------------
  app.get('/reportes/cuadre-caja', async (peticion) => {
    const { tienda_id = null, estado = null } = peticion.query;

    const { rows } = await db.query(
      `SELECT caja_id, tienda_id, tienda, usuario, estado, abierta_en, cerrada_en,
              monto_inicial, vendido_efectivo, abonado_efectivo, esperado,
              efectivo_contado, diferencia_registrada, diferencia_real, cuadra
         FROM v_cuadre_caja
        WHERE (@tienda_id IS NULL OR tienda_id = @tienda_id)
          AND (@estado    IS NULL OR estado    = @estado)
        ORDER BY abierta_en DESC`,
      { tienda_id: tienda_id === null ? null : Number(tienda_id), estado },
    );
    return { cajas: rows };
  });
}
