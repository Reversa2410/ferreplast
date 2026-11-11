-- =============================================================================
-- MIGRACION 001 -- el dia del reporte es el dia del negocio
--
-- QUE ARREGLA
-- v_ventas_diarias agrupaba por CAST(ocurrido_en AS DATE), que es la fecha UTC.
-- Nicaragua es UTC-6, asi que una venta de las 18:30 de la tarde queda guardada
-- como las 00:30 del dia SIGUIENTE y se contaba en el dia equivocado. Para una
-- ferreteria que cierra a la tarde eso corria las ultimas ventas de todos los
-- dias, en la pantalla principal, sin producir ningun error.
--
-- POR QUE EXISTE ESTE ARCHIVO Y NO SE CORRE schema.sql
-- schema.sql empieza con DROP TABLE: recrea la base entera y se lleva los
-- datos. Esta migracion NO toca ninguna tabla ni ningun dato: solo agrega dos
-- funciones y reemplaza una vista. Es la unica forma de aplicar el arreglo a
-- una base con datos reales adentro.
--
-- ES IDEMPOTENTE: se puede correr varias veces seguidas.
--
--   sqlcmd -S localhost -E -C -f 65001 -b -i db\migraciones\001-zona-horaria.sql
--
-- Para apuntar a otra base, cambiar el USE de abajo.
-- =============================================================================

USE FerreplastDB;
GO

-- Obligatorio con sqlcmd, que no las pone por omision: las vistas y funciones
-- capturan estas opciones en el momento de crearse, y sin ellas cualquier
-- escritura posterior sobre una tabla con indices filtrados falla.
SET QUOTED_IDENTIFIER ON;
SET ANSI_NULLS ON;
GO

PRINT 'Migracion 001: zona horaria';
PRINT '';

-- -----------------------------------------------------------------------------
-- Comprobacion previa: la zona tiene que existir en este servidor.
--
-- Si faltara, las funciones se crearian igual y fallarian al usarse, con un
-- error que aparece recien cuando alguien abre un reporte. Mejor ahora.
-- -----------------------------------------------------------------------------
IF NOT EXISTS (SELECT 1 FROM sys.time_zone_info
                WHERE name = 'Central America Standard Time')
    THROW 51001, 'Este servidor no conoce la zona Central America Standard Time.', 1;
GO

-- -----------------------------------------------------------------------------
-- Que dia local era, en Nicaragua, un momento guardado en UTC.
-- -----------------------------------------------------------------------------
CREATE OR ALTER FUNCTION fn_fecha_local(@momento DATETIME2(3))
RETURNS DATE
AS
BEGIN
    RETURN CAST(@momento AT TIME ZONE 'UTC'
                         AT TIME ZONE 'Central America Standard Time' AS DATE);
END;
GO

-- -----------------------------------------------------------------------------
-- En que momento UTC empieza un dia local. Es la operacion inversa, y sirve
-- para filtrar por rango sin convertir cada fila.
-- -----------------------------------------------------------------------------
CREATE OR ALTER FUNCTION fn_inicio_utc_del_dia(@fecha_local DATE)
RETURNS DATETIME2(3)
AS
BEGIN
    RETURN CAST(CAST(@fecha_local AS DATETIME2(3))
                    AT TIME ZONE 'Central America Standard Time'
                    AT TIME ZONE 'UTC' AS DATETIME2(3));
END;
GO

-- -----------------------------------------------------------------------------
-- La vista, agrupando por el dia del negocio.
--
-- La expresion va escrita a mano y no como llamada a fn_fecha_local porque esto
-- corre una vez POR VENTA: la funcion escalar da inline_type = 0, o sea que
-- SQL Server no la puede incrustar en el plan y la ejecutaria fila por fila
-- sobre el historial entero.
-- -----------------------------------------------------------------------------
CREATE OR ALTER VIEW v_ventas_diarias AS
WITH costos AS (
    SELECT l.venta_id, SUM(l.cantidad * l.costo_unitario) AS costo
      FROM VENTA_LINEA l
     GROUP BY l.venta_id
)
SELECT
    v.tienda_id,
    t.nombre                  AS tienda,
    CAST(v.ocurrido_en AT TIME ZONE 'UTC'
                       AT TIME ZONE 'Central America Standard Time' AS DATE) AS fecha,
    COUNT(*)                  AS cantidad_ventas,
    SUM(v.total)              AS total_vendido,
    SUM(ISNULL(c.costo, 0))   AS costo_mercaderia,
    SUM(v.total) - SUM(ISNULL(c.costo, 0)) AS ganancia_bruta,
    CAST(ROUND(AVG(v.total), 2) AS DECIMAL(18,2)) AS ticket_promedio
FROM VENTA v
JOIN TIENDA t ON t.id = v.tienda_id
-- LEFT JOIN: una venta sin lineas cargadas igual debe figurar en el reporte,
-- con costo cero, en lugar de desaparecer silenciosamente.
LEFT JOIN costos c ON c.venta_id = v.id
WHERE v.anulada = 0
GROUP BY v.tienda_id, t.nombre,
         CAST(v.ocurrido_en AT TIME ZONE 'UTC'
                            AT TIME ZONE 'Central America Standard Time' AS DATE);
GO

-- -----------------------------------------------------------------------------
-- Verificacion: que lo que quedo sea lo que se queria.
--
-- Se comprueba el TEXTO de la vista y no solo que exista, porque el error que
-- esta migracion arregla es precisamente una vista que existia y funcionaba.
-- -----------------------------------------------------------------------------
DECLARE @problemas INT = 0;

IF OBJECT_ID('fn_fecha_local') IS NULL
    OR OBJECT_ID('fn_inicio_utc_del_dia') IS NULL
BEGIN
    PRINT '  FALLA  faltan las funciones de conversion';
    SET @problemas += 1;
END
ELSE
    PRINT '  OK     las dos funciones de conversion existen';

IF OBJECT_DEFINITION(OBJECT_ID('v_ventas_diarias')) NOT LIKE '%AT TIME ZONE%'
BEGIN
    PRINT '  FALLA  v_ventas_diarias sigue agrupando por fecha UTC';
    SET @problemas += 1;
END
ELSE
    PRINT '  OK     v_ventas_diarias agrupa por el dia local';

-- La prueba de verdad, con una venta: 18:30 del 14 de enero en Nicaragua son
-- las 00:30 UTC del 15, y tiene que contarse en el 14. Se revierte al terminar.
BEGIN TRY
    BEGIN TRAN;

    INSERT INTO VENTA (tienda_id, usuario_id, numero, subtotal, descuento, total,
                       metodo_pago, ocurrido_en)
    SELECT TOP 1 t.id, NULL, 990001, 100.00, 0.00, 100.00, 'efectivo',
           '2026-01-15T00:30:00'
      FROM TIENDA t ORDER BY t.id;

    DECLARE @en_local INT = (SELECT COUNT(*) FROM v_ventas_diarias
                              WHERE fecha = '2026-01-14');
    DECLARE @en_utc   INT = (SELECT COUNT(*) FROM v_ventas_diarias
                              WHERE fecha = '2026-01-15');
    ROLLBACK;

    IF @en_local = 1 AND @en_utc = 0
        PRINT '  OK     una venta de las 18:30 se cuenta en su dia, no en el siguiente';
    ELSE
    BEGIN
        PRINT CONCAT('  FALLA  filas en el dia local: ', @en_local,
                     ', en el dia UTC: ', @en_utc);
        SET @problemas += 1;
    END
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK;
    PRINT CONCAT('  FALLA  no se pudo verificar con una venta: ', ERROR_MESSAGE());
    SET @problemas += 1;
END CATCH

PRINT '';
IF @problemas > 0
    THROW 51002, 'La migracion 001 no quedo aplicada correctamente.', 1;

PRINT 'Migracion 001 aplicada correctamente.';
GO
