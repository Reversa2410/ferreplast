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

-- Un administrador sin contrasenia no podria entrar por ningun lado.
BEGIN TRY
    BEGIN TRAN;
    INSERT INTO Usuario (negocio_id, nombre, rol, email)
    VALUES (1, 'Admin incompleto', 'administrador', 'otro@ferreplast.com');
    ROLLBACK;
    SET @ok = 0; SET @det = 'se creo un administrador sin contrasenia';
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK;
    SET @ok = 1;
END CATCH
INSERT INTO #resultado (seccion, nombre, ok, detalle)
VALUES ('usuarios', 'un administrador necesita email y contrasenia', @ok, @det);

-- Un empleado sin PIN tampoco.
--
-- Ya NO se le exige tienda: la pertenencia se mudo a USUARIO_TIENDA porque un
-- empleado puede trabajar en las dos, y un CHECK no puede mirar otra tabla.
SET @det = NULL;
BEGIN TRY
    BEGIN TRAN;
    INSERT INTO Usuario (negocio_id, nombre, rol, email, password_hash)
    VALUES (1, 'Empleado sin PIN', 'empleado', NULL, NULL);
    ROLLBACK;
    SET @ok = 0; SET @det = 'se creo un empleado sin PIN';
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK;
    SET @ok = 1;
END CATCH
INSERT INTO #resultado (seccion, nombre, ok, detalle)
VALUES ('usuarios', 'un empleado necesita PIN', @ok, @det);

-- Solo quedan dos roles: el 'encargado' del modelo anterior ya no existe.
SET @det = NULL;
BEGIN TRY
    BEGIN TRAN;
    INSERT INTO Usuario (negocio_id, nombre, rol, pin_hash)
    VALUES (1, 'Encargado fantasma', 'encargado', 'hash');
    ROLLBACK;
    SET @ok = 0; SET @det = 'se acepto el rol encargado';
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK;
    SET @ok = 1;
END CATCH
INSERT INTO #resultado (seccion, nombre, ok, detalle)
VALUES ('usuarios', 'solo existen los roles empleado y administrador', @ok, @det);

-- El email no se puede repetir.
SET @det = NULL;
BEGIN TRY
    BEGIN TRAN;
    INSERT INTO Usuario (negocio_id, nombre, rol, email, password_hash)
    VALUES (1, 'Clon', 'administrador', 'admin@ferreplast.com', 'hash');
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
    INSERT INTO Usuario (negocio_id, nombre, rol, pin_hash)
    VALUES (1, 'Empleado A', 'empleado', 'hashA'),
           (1, 'Empleado B', 'empleado', 'hashB');
    ROLLBACK;
    SET @ok = 1;
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK;
    SET @ok = 0; SET @det = ERROR_MESSAGE();
END CATCH
INSERT INTO #resultado (seccion, nombre, ok, detalle)
VALUES ('usuarios', 'varios empleados pueden no tener email', @ok, @det);

-- EL CASO QUE EL MODELO VIEJO NO PODIA REPRESENTAR: la misma persona
-- trabajando en los dos locales. Antes habia que crearle dos usuarios.
SET @det = NULL;
BEGIN TRY
    BEGIN TRAN;
    INSERT INTO USUARIO_TIENDA (usuario_id, tienda_id) VALUES (3, 1);
    SET @det = CONCAT('tiendas de Maria: ',
        (SELECT COUNT(*) FROM USUARIO_TIENDA WHERE usuario_id = 3));
    ROLLBACK;
    SET @ok = 1;
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK;
    SET @ok = 0; SET @det = ERROR_MESSAGE();
END CATCH
INSERT INTO #resultado (seccion, nombre, ok, detalle)
VALUES ('usuarios', 'un empleado puede trabajar en las dos tiendas', @ok, @det);

-- ...pero no dos veces en la misma (la clave primaria compuesta lo impide).
SET @det = NULL;
BEGIN TRY
    BEGIN TRAN;
    INSERT INTO USUARIO_TIENDA (usuario_id, tienda_id) VALUES (2, 1);
    ROLLBACK;
    SET @ok = 0; SET @det = 'se repitio la asignacion';
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK;
    SET @ok = 1;
END CATCH
INSERT INTO #resultado (seccion, nombre, ok, detalle)
VALUES ('usuarios', 'no se repite la misma tienda para el mismo empleado', @ok, @det);
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
DECLARE @cabeceras DECIMAL(18,2) = (
    SELECT SUM(total) FROM VENTA WHERE tienda_id = 1 AND anulada = 0);

SELECT @total = SUM(total_vendido), @ganancia = SUM(ganancia_bruta)
  FROM v_ventas_diarias
 WHERE tienda_id = 1;

-- Se compara contra la suma de las CABECERAS, no contra un numero escrito a
-- mano: asi la prueba sigue valiendo cuando cambian los datos de ejemplo, que
-- es lo unico que tiene que cambiar cuando cambia el seed.
SET @ok = CASE WHEN @total = @cabeceras THEN 1 ELSE 0 END;
SET @det = CONCAT('vista: ', @total, '  cabeceras: ', @cabeceras);
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
PRINT '=== 12. Credito, clientes y descuentos ===';
-- =============================================================================
DECLARE @ok BIT, @det VARCHAR(500) = NULL;
DECLARE @saldo DECIMAL(18,2), @cupo DECIMAL(18,2), @esperado DECIMAL(18,2);

-- No se puede fiar al aire: sin cliente no hay a quien cobrarle.
BEGIN TRY
    BEGIN TRAN;
    INSERT INTO VENTA (tienda_id, usuario_id, numero, subtotal, descuento, total, metodo_pago)
    VALUES (1, 2, 9001, 100.00, 0.00, 100.00, 'credito');
    ROLLBACK;
    SET @ok = 0; SET @det = 'se registro una venta a credito sin cliente';
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK;
    SET @ok = 1;
END CATCH
INSERT INTO #resultado (seccion, nombre, ok, detalle)
VALUES ('credito', 'una venta a credito exige cliente', @ok, @det);

-- El limite se respeta. Pedro tiene 1000 de cupo y no debe nada.
SET @det = NULL;
BEGIN TRY
    BEGIN TRAN;
    INSERT INTO VENTA (tienda_id, usuario_id, cliente_id, numero, subtotal, descuento, total, metodo_pago)
    VALUES (1, 2, 1, 9002, 2000.00, 0.00, 2000.00, 'credito');
    ROLLBACK;
    SET @ok = 0; SET @det = 'se fio por encima del limite';
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK;
    SET @ok = 1;
END CATCH
INSERT INTO #resultado (seccion, nombre, ok, detalle)
VALUES ('credito', 'rechaza una venta que supera el limite del cliente', @ok, @det);

-- ...y por debajo del limite si entra.
SET @det = NULL;
BEGIN TRY
    BEGIN TRAN;
    INSERT INTO VENTA (tienda_id, usuario_id, cliente_id, numero, subtotal, descuento, total, metodo_pago)
    VALUES (1, 2, 1, 9003, 500.00, 0.00, 500.00, 'credito');
    ROLLBACK;
    SET @ok = 1;
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK;
    SET @ok = 0; SET @det = ERROR_MESSAGE();
END CATCH
INSERT INTO #resultado (seccion, nombre, ok, detalle)
VALUES ('credito', 'acepta una venta dentro del cupo', @ok, @det);

-- EL AGUJERO QUE HABIA QUE CERRAR: entrar por debajo del limite y subir el
-- total despues. Con el trigger solo en AFTER INSERT esto pasaba de largo.
SET @det = NULL;
BEGIN TRY
    BEGIN TRAN;
    INSERT INTO VENTA (tienda_id, usuario_id, cliente_id, numero, subtotal, descuento, total, metodo_pago)
    VALUES (1, 2, 1, 9004, 500.00, 0.00, 500.00, 'credito');
    UPDATE VENTA SET subtotal = 3000.00, total = 3000.00 WHERE numero = 9004 AND tienda_id = 1;
    ROLLBACK;
    SET @ok = 0; SET @det = 'se esquivo el limite subiendo el total despues';
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK;
    SET @ok = 1;
END CATCH
INSERT INTO #resultado (seccion, nombre, ok, detalle)
VALUES ('credito', 'el limite tambien se valida al modificar la venta', @ok, @det);

-- Un abono de cero o negativo seria una venta disfrazada.
SET @det = NULL;
BEGIN TRY
    BEGIN TRAN;
    INSERT INTO PAGO_CREDITO (cliente_id, monto) VALUES (1, -50.00);
    ROLLBACK;
    SET @ok = 0; SET @det = 'se acepto un abono negativo';
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK;
    SET @ok = 1;
END CATCH
INSERT INTO #resultado (seccion, nombre, ok, detalle)
VALUES ('credito', 'rechaza un abono de monto no positivo', @ok, @det);

-- El saldo se DERIVA: fiado menos abonado. La constructora debe 4260 y abono 200.
SELECT @saldo = saldo, @cupo = cupo_disponible
  FROM v_cuentas_por_cobrar WHERE cliente_id = 2;
SET @ok = CASE WHEN @saldo = 4060.00 AND @cupo = 940.00 THEN 1 ELSE 0 END;
SET @det = CONCAT('saldo ', @saldo, ', cupo disponible ', @cupo);
INSERT INTO #resultado (seccion, nombre, ok, detalle)
VALUES ('credito', 'v_cuentas_por_cobrar deriva el saldo del cliente', @ok, @det);

-- Anular la venta fiada baja la deuda SOLA, sin que nadie reste nada.
SET @det = NULL;
BEGIN TRY
    BEGIN TRAN;
    UPDATE VENTA SET anulada = 1 WHERE id = 3;
    SELECT @saldo = saldo FROM v_cuentas_por_cobrar WHERE cliente_id = 2;
    ROLLBACK;
    -- Quedan los 200 abonados contra ninguna deuda: saldo negativo, a favor.
    SET @ok = CASE WHEN @saldo = -200.00 THEN 1 ELSE 0 END;
    SET @det = CONCAT('saldo tras anular: ', @saldo);
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK;
    SET @ok = 0; SET @det = ERROR_MESSAGE();
END CATCH
INSERT INTO #resultado (seccion, nombre, ok, detalle)
VALUES ('credito', 'anular una venta fiada baja la deuda sola', @ok, @det);

-- EL DETALLE QUE ROMPE EL ARQUEO: el abono en efectivo esta en el cajon sin
-- venta detras. Si v_cuadre_caja no lo suma, esta caja deja de cuadrar.
SELECT @esperado = esperado FROM v_cuadre_caja WHERE caja_id = 1;
SET @ok = CASE WHEN @esperado = 2080.00 THEN 1 ELSE 0 END;
SET @det = CONCAT('esperado en la caja 1: ', @esperado, ' (1000 + 880 ventas + 200 abono)');
INSERT INTO #resultado (seccion, nombre, ok, detalle)
VALUES ('credito', 'v_cuadre_caja suma los abonos en efectivo', @ok, @det);

-- La rebaja no puede superar el renglon: el subtotal saldria negativo.
SET @det = NULL;
BEGIN TRY
    BEGIN TRAN;
    INSERT INTO VENTA_LINEA (venta_id, numero, producto_id, cantidad, precio_unitario, costo_unitario, descuento, subtotal)
    VALUES (1, 90, 11, 1.000, 45.00, 36.00, 100.00, -55.00);
    ROLLBACK;
    SET @ok = 0; SET @det = 'se regalo mas de lo que valia el renglon';
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK;
    SET @ok = 1;
END CATCH
INSERT INTO #resultado (seccion, nombre, ok, detalle)
VALUES ('credito', 'la rebaja no puede superar el valor de la linea', @ok, @det);

-- Un producto, una linea: si no, la rebaja queda partida y el reporte miente.
SET @det = NULL;
BEGIN TRY
    BEGIN TRAN;
    INSERT INTO VENTA_LINEA (venta_id, numero, producto_id, cantidad, precio_unitario, costo_unitario, subtotal)
    VALUES (1, 91, 1, 1.000, 250.00, 150.00, 250.00);
    ROLLBACK;
    SET @ok = 0; SET @det = 'el mismo producto entro dos veces en la venta';
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK;
    SET @ok = 1;
END CATCH
INSERT INTO #resultado (seccion, nombre, ok, detalle)
VALUES ('credito', 'el mismo producto no se repite en una venta', @ok, @det);
GO

-- =============================================================================
-- 13. ZONA HORARIA -- que el dia del reporte sea el dia del negocio
--
-- Estas pruebas existen por un error que estuvo en el esquema y no fallaba
-- nunca: la vista agrupaba por CAST(ocurrido_en AS DATE), que es la fecha UTC,
-- y Nicaragua es UTC-6. Las ventas de la tarde se contaban en el dia
-- siguiente. No habia ninguna excepcion ni ningun numero absurdo: solo el
-- total del dia corrido.
--
-- Se usa una fecha de enero a proposito, bien lejos de "hoy": si se probara
-- con la fecha actual, un resultado correcto y uno incorrecto podrian caer en
-- el mismo dia y la prueba pasaria por casualidad.
-- =============================================================================
DECLARE @ok BIT, @det NVARCHAR(400), @n INT, @importe DECIMAL(18,2);

-- 18:30 del 14 de enero en Nicaragua = 00:30 UTC del 15.
DECLARE @tarde       DATETIME2(3) = '2026-01-15T00:30:00';
-- 23:59 del 14 de enero en Nicaragua = 05:59 UTC del 15.
DECLARE @noche       DATETIME2(3) = '2026-01-15T05:59:00';
DECLARE @dia_local   DATE = '2026-01-14';
DECLARE @dia_utc     DATE = '2026-01-15';

-- -----------------------------------------------------------------------------
-- La zona sigue siendo UTC-6 y sin horario de verano.
--
-- Nicaragua lo tuvo hasta 2006. Si el sistema operativo trajera una regla
-- nueva, los numeros cambiarian solos y esta prueba es la que lo diria.
-- -----------------------------------------------------------------------------
SELECT @det = CONCAT('desfase ', current_utc_offset, ', horario de verano ', is_currently_dst)
  FROM sys.time_zone_info WHERE name = 'Central America Standard Time';
SET @ok = CASE WHEN @det = 'desfase -06:00, horario de verano 0' THEN 1 ELSE 0 END;
INSERT INTO #resultado (seccion, nombre, ok, detalle)
VALUES ('zona horaria', 'Nicaragua sigue en UTC-6 sin horario de verano', @ok, @det);

-- -----------------------------------------------------------------------------
-- Las dos funciones de conversion
-- -----------------------------------------------------------------------------
SET @ok = CASE WHEN dbo.fn_fecha_local(@tarde) = @dia_local THEN 1 ELSE 0 END;
SET @det = CONCAT('18:30 locales guardadas como ', CONVERT(VARCHAR(20), @tarde, 120),
                  ' -> dia ', dbo.fn_fecha_local(@tarde), ' (UTC diria ', @dia_utc, ')');
INSERT INTO #resultado (seccion, nombre, ok, detalle)
VALUES ('zona horaria', 'una venta de la tarde pertenece al dia local', @ok, @det);

SET @ok = CASE WHEN dbo.fn_fecha_local(@noche) = @dia_local THEN 1 ELSE 0 END;
SET @det = CONCAT('23:59 locales -> dia ', dbo.fn_fecha_local(@noche));
INSERT INTO #resultado (seccion, nombre, ok, detalle)
VALUES ('zona horaria', 'una venta de la noche tampoco se adelanta', @ok, @det);

-- El dia local empieza a las 06:00 UTC, no a las 00:00.
SET @ok = CASE WHEN dbo.fn_inicio_utc_del_dia(@dia_local) = '2026-01-14T06:00:00'
               THEN 1 ELSE 0 END;
SET @det = CONCAT('el dia local ', @dia_local, ' empieza en UTC a las ',
                  CONVERT(VARCHAR(20), dbo.fn_inicio_utc_del_dia(@dia_local), 120));
INSERT INTO #resultado (seccion, nombre, ok, detalle)
VALUES ('zona horaria', 'fn_inicio_utc_del_dia ubica el corte del dia', @ok, @det);

-- Las dos funciones tienen que ser inversas una de la otra: si no, un reporte
-- que agrupa y otro que filtra darian conjuntos distintos para el mismo dia.
SET @ok = CASE WHEN @tarde >= dbo.fn_inicio_utc_del_dia(@dia_local)
               AND  @tarde <  dbo.fn_inicio_utc_del_dia(DATEADD(DAY, 1, @dia_local))
               AND  @noche >= dbo.fn_inicio_utc_del_dia(@dia_local)
               AND  @noche <  dbo.fn_inicio_utc_del_dia(DATEADD(DAY, 1, @dia_local))
               THEN 1 ELSE 0 END;
INSERT INTO #resultado (seccion, nombre, ok, detalle)
VALUES ('zona horaria', 'agrupar por dia y filtrar por rango dan lo mismo', @ok, NULL);

-- -----------------------------------------------------------------------------
-- LA PRUEBA QUE IMPORTA: la vista, con ventas de verdad.
--
-- Dos ventas que en Nicaragua son del mismo dia (18:30 y 23:59) pero que en
-- UTC caen las dos en el dia siguiente. La vista tiene que juntarlas en el 14
-- y no crear ninguna fila para el 15.
-- -----------------------------------------------------------------------------
BEGIN TRY
    BEGIN TRAN;

    INSERT INTO VENTA (tienda_id, usuario_id, numero, subtotal, descuento, total,
                       metodo_pago, ocurrido_en)
    VALUES (1, 2, 990001, 100.00, 0.00, 100.00, 'efectivo', @tarde),
           (1, 2, 990002, 250.00, 0.00, 250.00, 'efectivo', @noche);

    SELECT @n = cantidad_ventas, @importe = total_vendido
      FROM v_ventas_diarias
     WHERE tienda_id = 1 AND fecha = @dia_local;

    DECLARE @filas_en_utc INT;
    SELECT @filas_en_utc = COUNT(*)
      FROM v_ventas_diarias
     WHERE tienda_id = 1 AND fecha = @dia_utc;

    ROLLBACK;

    SET @ok = CASE WHEN @n = 2 AND @importe = 350.00 AND @filas_en_utc = 0
                   THEN 1 ELSE 0 END;
    SET @det = CONCAT('en el dia local: ', ISNULL(@n, 0), ' ventas por ',
                      ISNULL(@importe, 0), ' | filas en el dia UTC: ', @filas_en_utc);
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK;
    SET @ok = 0;
    SET @det = CONCAT('error: ', ERROR_MESSAGE());
END CATCH
INSERT INTO #resultado (seccion, nombre, ok, detalle)
VALUES ('zona horaria', 'v_ventas_diarias agrupa por el dia del negocio', @ok, @det);
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
