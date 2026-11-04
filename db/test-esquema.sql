-- =============================================================================
-- FERREPLAST -- Pruebas del esquema
--
-- Comprueba que las reglas del modelo se CUMPLAN, no que el script compile.
-- Cada prueba intenta algo que deberia ser imposible y verifica que la base lo
-- rechace, o hace algo valido y verifica que el resultado sea el correcto.
--
-- Ejecutar DESPUES de schema.sql y seed.sql:
--   sqlcmd -S localhost -E -C -f 65001 -i db/test-esquema.sql
--
-- NO DEJA RASTRO: cada prueba que escribe lo hace dentro de una transaccion
-- que se revierte. La base queda como estaba.
--
-- POR QUE EL RESULTADO SE GUARDA DESPUES DEL ROLLBACK:
-- una tabla temporal es transaccional. Si se anotara el resultado adentro de
-- la transaccion, el ROLLBACK se lo llevaria junto con la prueba. Por eso cada
-- bloque decide en una variable, revierte, y recien entonces anota.
-- =============================================================================

USE FerreplastDB;
GO

SET QUOTED_IDENTIFIER ON;
SET ANSI_NULLS ON;
SET NOCOUNT ON;
GO

DROP TABLE IF EXISTS #resultado;
CREATE TABLE #resultado (
    orden   INT IDENTITY(1,1),
    seccion VARCHAR(80),
    nombre  VARCHAR(200),
    ok      BIT,
    detalle VARCHAR(500)
);
GO

-- =============================================================================
PRINT '=== 1. Restricciones de los movimientos de inventario ===';
-- =============================================================================
DECLARE @ok BIT, @det VARCHAR(500) = NULL;

-- Una venta no puede AUMENTAR el stock.
BEGIN TRY
    BEGIN TRAN;
    INSERT INTO MOVIMIENTO_INVENTARIO (tienda_id, producto_id, tipo, cantidad)
    VALUES (1, 1, 'venta', 5);
    ROLLBACK;
    SET @ok = 0; SET @det = 'se acepto una venta con cantidad positiva';
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK;
    SET @ok = 1;
END CATCH
INSERT INTO #resultado (seccion, nombre, ok, detalle)
VALUES ('movimientos', 'rechaza una venta con cantidad positiva', @ok, @det);

-- Una entrada no puede descontar.
SET @det = NULL;
BEGIN TRY
    BEGIN TRAN;
    INSERT INTO MOVIMIENTO_INVENTARIO (tienda_id, producto_id, tipo, cantidad)
    VALUES (1, 1, 'entrada', -5);
    ROLLBACK;
    SET @ok = 0; SET @det = 'se acepto una entrada negativa';
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK;
    SET @ok = 1;
END CATCH
INSERT INTO #resultado (seccion, nombre, ok, detalle)
VALUES ('movimientos', 'rechaza una entrada con cantidad negativa', @ok, @det);

-- Un movimiento de cero no significa nada.
SET @det = NULL;
BEGIN TRY
    BEGIN TRAN;
    INSERT INTO MOVIMIENTO_INVENTARIO (tienda_id, producto_id, tipo, cantidad)
    VALUES (1, 1, 'ajuste', 0);
    ROLLBACK;
    SET @ok = 0; SET @det = 'se acepto cantidad cero';
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK;
    SET @ok = 1;
END CATCH
INSERT INTO #resultado (seccion, nombre, ok, detalle)
VALUES ('movimientos', 'rechaza un movimiento de cantidad cero', @ok, @det);

-- El ajuste SI puede ir en cualquier direccion: es la unica forma de corregir.
SET @det = NULL;
BEGIN TRY
    BEGIN TRAN;
    INSERT INTO MOVIMIENTO_INVENTARIO (tienda_id, producto_id, tipo, cantidad)
    VALUES (1, 1, 'ajuste', -3);
    ROLLBACK;
    SET @ok = 1;
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK;
    SET @ok = 0; SET @det = ERROR_MESSAGE();
END CATCH
INSERT INTO #resultado (seccion, nombre, ok, detalle)
VALUES ('movimientos', 'acepta un ajuste negativo', @ok, @det);

-- Un tipo que no existe.
SET @det = NULL;
BEGIN TRY
    BEGIN TRAN;
    INSERT INTO MOVIMIENTO_INVENTARIO (tienda_id, producto_id, tipo, cantidad)
    VALUES (1, 1, 'regalo', 5);
    ROLLBACK;
    SET @ok = 0; SET @det = 'se acepto un tipo fuera de la lista';
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK;
    SET @ok = 1;
END CATCH
INSERT INTO #resultado (seccion, nombre, ok, detalle)
VALUES ('movimientos', 'rechaza un tipo de movimiento inventado', @ok, @det);
GO

-- =============================================================================
PRINT '=== 2. El historial es inmutable ===';
-- =============================================================================
DECLARE @ok BIT, @det VARCHAR(500) = NULL;

BEGIN TRY
    BEGIN TRAN;
    UPDATE MOVIMIENTO_INVENTARIO SET cantidad = 999 WHERE id = 1;
    ROLLBACK;
    SET @ok = 0; SET @det = 'se pudo modificar un movimiento';
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK;
    SET @ok = 1;
END CATCH
INSERT INTO #resultado (seccion, nombre, ok, detalle)
VALUES ('inmutabilidad', 'no se puede modificar un movimiento registrado', @ok, @det);

SET @det = NULL;
BEGIN TRY
    BEGIN TRAN;
    DELETE FROM MOVIMIENTO_INVENTARIO WHERE id = 1;
    ROLLBACK;
    SET @ok = 0; SET @det = 'se pudo borrar un movimiento';
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK;
    SET @ok = 1;
END CATCH
INSERT INTO #resultado (seccion, nombre, ok, detalle)
VALUES ('inmutabilidad', 'no se puede borrar un movimiento registrado', @ok, @det);
GO

-- =============================================================================
PRINT '=== 3. El trigger que mantiene el stock ===';
-- =============================================================================
DECLARE @ok BIT, @det VARCHAR(500) = NULL, @antes DECIMAL(18,3), @despues DECIMAL(18,3);

-- Caso simple: una entrada sube el stock.
BEGIN TRY
    BEGIN TRAN;
    SELECT @antes = cantidad FROM Stock WHERE tienda_id = 1 AND producto_id = 1;
    INSERT INTO MOVIMIENTO_INVENTARIO (tienda_id, producto_id, tipo, cantidad)
    VALUES (1, 1, 'entrada', 25);
    SELECT @despues = cantidad FROM Stock WHERE tienda_id = 1 AND producto_id = 1;
    ROLLBACK;
    SET @ok = CASE WHEN @despues = @antes + 25 THEN 1 ELSE 0 END;
    SET @det = CONCAT('antes ', @antes, ', despues ', @despues);
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK;
    SET @ok = 0; SET @det = ERROR_MESSAGE();
END CATCH
INSERT INTO #resultado (seccion, nombre, ok, detalle)
VALUES ('trigger stock', 'una entrada sube el stock', @ok, @det);

-- EL CASO QUE ROMPE LOS TRIGGERS MAL ESCRITOS.
--
-- En SQL Server el trigger se dispara UNA VEZ POR SENTENCIA, no por fila. Un
-- trigger escrito como si 'inserted' trajera una sola fila aplicaria solo una
-- de las tres y perderia las otras dos sin avisar. Es el error que aparece
-- recien cuando una tablet sincroniza un lote entero.
SET @det = NULL;
BEGIN TRY
    BEGIN TRAN;
    SELECT @antes = cantidad FROM Stock WHERE tienda_id = 1 AND producto_id = 2;
    INSERT INTO MOVIMIENTO_INVENTARIO (tienda_id, producto_id, tipo, cantidad)
    VALUES (1, 2, 'entrada', 10),
           (1, 2, 'entrada', 20),
           (1, 2, 'merma',   -5);
    SELECT @despues = cantidad FROM Stock WHERE tienda_id = 1 AND producto_id = 2;
    ROLLBACK;
    SET @ok = CASE WHEN @despues = @antes + 25 THEN 1 ELSE 0 END;
    SET @det = CONCAT('esperado ', @antes + 25, ', obtenido ', @despues);
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK;
    SET @ok = 0; SET @det = ERROR_MESSAGE();
END CATCH
INSERT INTO #resultado (seccion, nombre, ok, detalle)
VALUES ('trigger stock', 'un lote de 3 movimientos del mismo producto se aplica entero', @ok, @det);

-- Un producto que nunca tuvo stock en esa tienda: el trigger crea la fila.
SET @det = NULL;
BEGIN TRY
    BEGIN TRAN;
    INSERT INTO MOVIMIENTO_INVENTARIO (tienda_id, producto_id, tipo, cantidad)
    VALUES (2, 1, 'entrada', 7);   -- el martillo no se vende en la plastiqueria
    SELECT @despues = cantidad FROM Stock WHERE tienda_id = 2 AND producto_id = 1;
    ROLLBACK;
    SET @ok = CASE WHEN @despues = 7 THEN 1 ELSE 0 END;
    SET @det = CONCAT('stock creado: ', ISNULL(CAST(@despues AS VARCHAR), 'NULL'));
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK;
    SET @ok = 0; SET @det = ERROR_MESSAGE();
END CATCH
INSERT INTO #resultado (seccion, nombre, ok, detalle)
VALUES ('trigger stock', 'crea la fila de stock si el producto no la tenia', @ok, @det);
GO

-- =============================================================================
PRINT '=== 4. Idempotencia de la sincronizacion ===';
-- =============================================================================
DECLARE @ok BIT, @det VARCHAR(500) = NULL;
DECLARE @uuid UNIQUEIDENTIFIER = '99999999-9999-9999-9999-999999999999';

-- El mismo movimiento enviado dos veces por una tablet que reintenta.
BEGIN TRY
    BEGIN TRAN;
    INSERT INTO MOVIMIENTO_INVENTARIO (uuid_externo, tienda_id, producto_id, tipo, cantidad)
    VALUES (@uuid, 1, 1, 'entrada', 10);
    INSERT INTO MOVIMIENTO_INVENTARIO (uuid_externo, tienda_id, producto_id, tipo, cantidad)
    VALUES (@uuid, 1, 1, 'entrada', 10);
    ROLLBACK;
    SET @ok = 0; SET @det = 'el reenvio se aplico dos veces';
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK;
    SET @ok = 1;
END CATCH
INSERT INTO #resultado (seccion, nombre, ok, detalle)
VALUES ('idempotencia', 'reenviar el mismo movimiento no lo duplica', @ok, @det);

-- Varios movimientos SIN uuid si pueden convivir: el indice unico es filtrado,
-- asi que ignora los NULL. Si no fuera filtrado, solo podria existir un unico
-- movimiento sin identificador externo en toda la tabla.
SET @det = NULL;
BEGIN TRY
    BEGIN TRAN;
    INSERT INTO MOVIMIENTO_INVENTARIO (tienda_id, producto_id, tipo, cantidad)
    VALUES (1, 1, 'entrada', 1), (1, 1, 'entrada', 2);
    ROLLBACK;
    SET @ok = 1;
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK;
    SET @ok = 0; SET @det = ERROR_MESSAGE();
END CATCH
INSERT INTO #resultado (seccion, nombre, ok, detalle)
VALUES ('idempotencia', 'varios movimientos sin uuid conviven (indice filtrado)', @ok, @det);
GO

-- =============================================================================
PRINT '=== 5. Coherencia de las ventas ===';
-- =============================================================================
DECLARE @ok BIT, @det VARCHAR(500) = NULL;

-- El total tiene que ser subtotal menos descuento.
BEGIN TRY
    BEGIN TRAN;
    INSERT INTO VENTA (tienda_id, usuario_id, numero, subtotal, descuento, total)
    VALUES (1, 2, 9001, 100.00, 10.00, 9999.00);
    ROLLBACK;
    SET @ok = 0; SET @det = 'se acepto un total incoherente';
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK;
    SET @ok = 1;
END CATCH
INSERT INTO #resultado (seccion, nombre, ok, detalle)
VALUES ('ventas', 'rechaza un total que no es subtotal menos descuento', @ok, @det);

-- Dos comprobantes no pueden compartir numero DENTRO de la misma tienda.
SET @det = NULL;
BEGIN TRY
    BEGIN TRAN;
    INSERT INTO VENTA (tienda_id, usuario_id, numero, subtotal, descuento, total)
    VALUES (1, 2, 1001, 50.00, 0.00, 50.00);   -- el 1001 ya existe en la tienda 1
    ROLLBACK;
    SET @ok = 0; SET @det = 'se acepto un numero de factura repetido';
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK;
    SET @ok = 1;
END CATCH
INSERT INTO #resultado (seccion, nombre, ok, detalle)
VALUES ('ventas', 'rechaza dos facturas con el mismo numero en una tienda', @ok, @det);

-- ...pero SI en la otra: cada tienda numera en paralelo aunque esten
-- desconectadas entre si.
SET @det = NULL;
BEGIN TRY
    BEGIN TRAN;
    INSERT INTO VENTA (tienda_id, usuario_id, numero, subtotal, descuento, total)
    VALUES (2, 3, 1001, 50.00, 0.00, 50.00);
    ROLLBACK;
    SET @ok = 1;
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK;
    SET @ok = 0; SET @det = ERROR_MESSAGE();
END CATCH
INSERT INTO #resultado (seccion, nombre, ok, detalle)
VALUES ('ventas', 'la otra tienda puede usar el mismo numero', @ok, @det);

-- El subtotal de una linea tiene que ser cantidad por precio.
SET @det = NULL;
BEGIN TRY
    BEGIN TRAN;
    INSERT INTO VENTA_LINEA (venta_id, numero, producto_id, cantidad, precio_unitario, costo_unitario, subtotal)
    VALUES (1, 99, 1, 2.000, 250.00, 150.00, 10.00);
    ROLLBACK;
    SET @ok = 0; SET @det = 'se acepto un subtotal que no coincide';
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK;
    SET @ok = 1;
END CATCH
INSERT INTO #resultado (seccion, nombre, ok, detalle)
VALUES ('ventas', 'rechaza una linea cuyo subtotal no es cantidad x precio', @ok, @det);

-- Metodo de pago fuera de la lista.
SET @det = NULL;
BEGIN TRY
    BEGIN TRAN;
    INSERT INTO VENTA (tienda_id, usuario_id, numero, subtotal, descuento, total, metodo_pago)
    VALUES (1, 2, 9002, 50.00, 0.00, 50.00, 'trueque');
    ROLLBACK;
    SET @ok = 0; SET @det = 'se acepto un metodo de pago inventado';
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK;
    SET @ok = 1;
END CATCH
INSERT INTO #resultado (seccion, nombre, ok, detalle)
VALUES ('ventas', 'rechaza un metodo de pago fuera de la lista', @ok, @det);
GO

-- =============================================================================
PRINT '=== 6. Caja ===';
-- =============================================================================
DECLARE @ok BIT, @det VARCHAR(500) = NULL;

-- Una sola caja ABIERTA por tienda.
BEGIN TRY
    BEGIN TRAN;
    INSERT INTO CAJA (tienda_id, usuario_id, monto_inicial, estado)
    VALUES (1, 2, 500.00, 'abierta');
    INSERT INTO CAJA (tienda_id, usuario_id, monto_inicial, estado)
    VALUES (1, 2, 300.00, 'abierta');
    ROLLBACK;
    SET @ok = 0; SET @det = 'se abrieron dos cajas en la misma tienda';
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK;
    SET @ok = 1;
END CATCH
INSERT INTO #resultado (seccion, nombre, ok, detalle)
VALUES ('caja', 'no se pueden abrir dos cajas a la vez en una tienda', @ok, @det);

-- ...pero una en cada tienda si.
SET @det = NULL;
BEGIN TRY
    BEGIN TRAN;
    INSERT INTO CAJA (tienda_id, usuario_id, monto_inicial, estado)
    VALUES (1, 2, 500.00, 'abierta');
    INSERT INTO CAJA (tienda_id, usuario_id, monto_inicial, estado)
    VALUES (2, 3, 300.00, 'abierta');
    ROLLBACK;
    SET @ok = 1;
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK;
    SET @ok = 0; SET @det = ERROR_MESSAGE();
END CATCH
INSERT INTO #resultado (seccion, nombre, ok, detalle)
VALUES ('caja', 'cada tienda puede tener la suya abierta', @ok, @det);

-- No se puede cerrar una caja sin haberla arqueado.
SET @det = NULL;
BEGIN TRY
    BEGIN TRAN;
    INSERT INTO CAJA (tienda_id, usuario_id, monto_inicial, estado, cerrada_en)
    VALUES (1, 2, 500.00, 'cerrada', SYSUTCDATETIME());   -- sin efectivo_contado
    ROLLBACK;
    SET @ok = 0; SET @det = 'se cerro una caja sin contar el efectivo';
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK;
    SET @ok = 1;
END CATCH
INSERT INTO #resultado (seccion, nombre, ok, detalle)
VALUES ('caja', 'no se puede cerrar una caja sin contar el efectivo', @ok, @det);
GO

-- =============================================================================
PRINT '=== 7. Usuarios y credenciales ===';
-- =============================================================================
DECLARE @ok BIT, @det VARCHAR(500) = NULL;

-- Un admin sin contrasenia no podria entrar por ningun lado.
BEGIN TRY
    BEGIN TRAN;
    INSERT INTO Usuario (negocio_id, nombre, rol, email)
    VALUES (1, 'Admin incompleto', 'admin', 'otro@ferreplast.com');
    ROLLBACK;
    SET @ok = 0; SET @det = 'se creo un admin sin contrasenia';
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK;
    SET @ok = 1;
END CATCH
INSERT INTO #resultado (seccion, nombre, ok, detalle)
VALUES ('usuarios', 'un admin necesita email y contrasenia', @ok, @det);

-- Un empleado sin tienda tampoco.
SET @det = NULL;
BEGIN TRY
    BEGIN TRAN;
    INSERT INTO Usuario (negocio_id, nombre, rol, pin_hash)
    VALUES (1, 'Empleado sin tienda', 'empleado', 'hash');
    ROLLBACK;
    SET @ok = 0; SET @det = 'se creo un empleado sin tienda';
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK;
    SET @ok = 1;
END CATCH
INSERT INTO #resultado (seccion, nombre, ok, detalle)
VALUES ('usuarios', 'un empleado necesita PIN y tienda', @ok, @det);

-- El email no se puede repetir.
SET @det = NULL;
BEGIN TRY
    BEGIN TRAN;
    INSERT INTO Usuario (negocio_id, nombre, rol, email, password_hash)
    VALUES (1, 'Clon', 'admin', 'admin@ferreplast.com', 'hash');
    ROLLBACK;
    SET @ok = 0; SET @det = 'se acepto un email repetido';
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK;
    SET @ok = 1;
END CATCH
INSERT INTO #resultado (seccion, nombre, ok, detalle)
VALUES ('usuarios', 'rechaza dos usuarios con el mismo email', @ok, @det);

-- ...pero varios empleados sin email si (el indice unico es filtrado).
SET @det = NULL;
BEGIN TRY
    BEGIN TRAN;
    INSERT INTO Usuario (negocio_id, tienda_id, nombre, rol, pin_hash)
    VALUES (1, 1, 'Empleado A', 'empleado', 'hashA'),
           (1, 1, 'Empleado B', 'empleado', 'hashB');
    ROLLBACK;
    SET @ok = 1;
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK;
    SET @ok = 0; SET @det = ERROR_MESSAGE();
END CATCH
INSERT INTO #resultado (seccion, nombre, ok, detalle)
VALUES ('usuarios', 'varios empleados pueden no tener email', @ok, @det);
GO

-- =============================================================================
PRINT '=== 8. Sesiones ===';
-- =============================================================================
DECLARE @ok BIT, @det VARCHAR(500) = NULL;

-- Una sesion no puede caducar antes de haber nacido.
BEGIN TRY
    BEGIN TRAN;
    INSERT INTO SESION (token_hash, usuario_id, expira_en, created_at)
    VALUES (REPLICATE('a', 64), 1,
            DATEADD(HOUR, -1, SYSUTCDATETIME()), SYSUTCDATETIME());
    ROLLBACK;
    SET @ok = 0; SET @det = 'se acepto una sesion ya vencida al crearse';
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK;
    SET @ok = 1;
END CATCH
INSERT INTO #resultado (seccion, nombre, ok, detalle)
VALUES ('sesiones', 'una sesion no puede nacer vencida', @ok, @det);
GO

-- =============================================================================
PRINT '=== 9. La columna calculada de reposicion ===';
-- =============================================================================
DECLARE @ok BIT, @det VARCHAR(500) = NULL;

-- No se puede escribir a mano: la calcula la base.
--
-- VA POR SQL DINAMICO Y NO DIRECTO, por un motivo que vale la pena entender:
-- escribir una columna calculada es un error de COMPILACION, no de ejecucion.
-- SQL Server rechaza el lote entero antes de ejecutar una sola linea, asi que
-- el TRY/CATCH jamas llega a atraparlo y se pierden todas las pruebas que
-- vengan despues en ese mismo lote.
--
-- Metiendolo en sp_executesql, la compilacion de esa sentencia ocurre recien
-- al ejecutarla, ya dentro del TRY, y el error se puede capturar.
BEGIN TRY
    BEGIN TRAN;
    EXEC sp_executesql
        N'UPDATE Stock SET necesita_reposicion = 0 WHERE tienda_id = 1 AND producto_id = 13;';
    ROLLBACK;
    SET @ok = 0; SET @det = 'se pudo escribir una columna calculada';
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK;
    SET @ok = 1;
END CATCH
INSERT INTO #resultado (seccion, nombre, ok, detalle)
VALUES ('calculadas', 'necesita_reposicion no se puede falsear a mano', @ok, @det);

-- Y se actualiza sola cuando cambia el stock.
SET @det = NULL;
DECLARE @flag INT;
BEGIN TRY
    BEGIN TRAN;
    -- El cemento esta en alerta (minima 200). Si entran 500 deja de estarlo.
    INSERT INTO MOVIMIENTO_INVENTARIO (tienda_id, producto_id, tipo, cantidad)
    VALUES (1, 13, 'entrada', 500);
    SELECT @flag = necesita_reposicion FROM Stock WHERE tienda_id = 1 AND producto_id = 13;
    ROLLBACK;
    SET @ok = CASE WHEN @flag = 0 THEN 1 ELSE 0 END;
    SET @det = CONCAT('necesita_reposicion quedo en ', @flag);
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK;
    SET @ok = 0; SET @det = ERROR_MESSAGE();
END CATCH
INSERT INTO #resultado (seccion, nombre, ok, detalle)
VALUES ('calculadas', 'la alerta se apaga sola al reponer stock', @ok, @det);
GO

-- =============================================================================
PRINT '=== 10. Las vistas de reportes ===';
-- =============================================================================
DECLARE @ok BIT, @det VARCHAR(500) = NULL;
DECLARE @total DECIMAL(18,2), @ganancia DECIMAL(18,2), @n INT;

-- FAN-OUT: la venta 1 tiene DOS lineas. Si la vista uniera cabecera con lineas
-- y sumara, el total saldria 1760 en lugar de 880 y la ganancia saldria al
-- doble. El numero parece razonable y por eso nadie lo cuestiona.
SELECT @total = total_vendido, @ganancia = ganancia_bruta
  FROM v_ventas_diarias
 WHERE tienda_id = 1;

SET @ok = CASE WHEN @total = 880.00 THEN 1 ELSE 0 END;
SET @det = CONCAT('total_vendido de la ferreteria: ', @total);
INSERT INTO #resultado (seccion, nombre, ok, detalle)
VALUES ('vistas', 'v_ventas_diarias no duplica una venta de dos lineas', @ok, @det);

-- La ganancia es venta menos COSTO, no la venta.
SET @ok = CASE WHEN @ganancia > 0 AND @ganancia < @total THEN 1 ELSE 0 END;
SET @det = CONCAT('vendido ', @total, ', ganancia ', @ganancia);
INSERT INTO #resultado (seccion, nombre, ok, detalle)
VALUES ('vistas', 'v_ventas_diarias calcula la ganancia real', @ok, @det);

-- El inventario se puede valorizar a costo Y a precio de venta. Con una sola
-- columna de precio esto era imposible.
SELECT @n = COUNT(*) FROM v_inventario_valorizado
 WHERE valor_costo > 0 AND valor_venta > valor_costo;
SET @ok = CASE WHEN @n > 90 THEN 1 ELSE 0 END;
SET @det = CONCAT('productos con costo y venta coherentes: ', @n);
INSERT INTO #resultado (seccion, nombre, ok, detalle)
VALUES ('vistas', 'v_inventario_valorizado valoriza a costo y a venta', @ok, @det);

-- La caja cuadra: lo esperado se recalcula desde las ventas, no se guarda.
SELECT @n = COUNT(*) FROM v_cuadre_caja WHERE cuadra = 0;
SET @ok = CASE WHEN @n = 0 THEN 1 ELSE 0 END;
SET @det = CONCAT('cajas que no cuadran: ', @n);
INSERT INTO #resultado (seccion, nombre, ok, detalle)
VALUES ('vistas', 'v_cuadre_caja recalcula lo esperado y da 0 descuadres', @ok, @det);

-- La vista detecta un descuadre inventado.
SET @det = NULL;
BEGIN TRY
    BEGIN TRAN;
    UPDATE CAJA SET diferencia = 777.00 WHERE id = 1;
    SELECT @n = COUNT(*) FROM v_cuadre_caja WHERE caja_id = 1 AND cuadra = 0;
    ROLLBACK;
    SET @ok = CASE WHEN @n = 1 THEN 1 ELSE 0 END;
    SET @det = CONCAT('descuadres detectados: ', @n);
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK;
    SET @ok = 0; SET @det = ERROR_MESSAGE();
END CATCH
INSERT INTO #resultado (seccion, nombre, ok, detalle)
VALUES ('vistas', 'v_cuadre_caja detecta una diferencia falseada', @ok, @det);
GO

-- =============================================================================
PRINT '=== 11. Reconciliacion del cache de stock ===';
-- =============================================================================
DECLARE @ok BIT, @det VARCHAR(500) = NULL, @desvios INT;

-- El cache tiene que coincidir con la verdad: la suma de los movimientos.
SELECT @desvios = COUNT(*)
  FROM (SELECT tienda_id, producto_id, SUM(cantidad) AS real_
          FROM MOVIMIENTO_INVENTARIO
         GROUP BY tienda_id, producto_id) v
  JOIN Stock s ON s.tienda_id = v.tienda_id AND s.producto_id = v.producto_id
 WHERE s.cantidad <> v.real_;

SET @ok = CASE WHEN @desvios = 0 THEN 1 ELSE 0 END;
SET @det = CONCAT('filas desalineadas: ', @desvios);
INSERT INTO #resultado (seccion, nombre, ok, detalle)
VALUES ('reconciliacion', 'Stock coincide con la suma de los movimientos', @ok, @det);
GO

-- =============================================================================
-- RESUMEN
-- =============================================================================
PRINT '';
SELECT
    CASE WHEN ok = 1 THEN '  OK  ' ELSE ' FALLA' END AS estado,
    seccion,
    nombre,
    ISNULL(detalle, '') AS detalle
FROM #resultado
ORDER BY orden;

DECLARE @pasadas INT = (SELECT COUNT(*) FROM #resultado WHERE ok = 1);
DECLARE @fallidas INT = (SELECT COUNT(*) FROM #resultado WHERE ok = 0);

PRINT '';
PRINT REPLICATE('=', 60);
PRINT CONCAT('Pruebas pasadas: ', @pasadas, '   fallidas: ', @fallidas);
PRINT REPLICATE('=', 60);

DROP TABLE #resultado;

IF @fallidas > 0
    THROW 50099, 'Hay pruebas del esquema que fallaron.', 1;
GO
