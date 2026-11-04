-- =============================================================================
-- FERREPLAST -- Datos de prueba
--
-- Ejecutar DESPUES de schema.sql:
--   sqlcmd -S localhost -E -C -f 65001 -i db/seed.sql
--
-- SOBRE EL STOCK INICIAL
-- No se insertan filas en Stock directamente. Se registran movimientos de
-- 'entrada' y el trigger construye el stock a partir de ellos.
--
-- Es a proposito: Stock es un cache, no la verdad. Sembrarlo a mano produciria
-- justo lo que el modelo quiere evitar -- un inventario que nadie puede
-- explicar, porque no hay ningun hecho registrado que justifique esos numeros.
-- Asi, cada unidad en el estante tiene un movimiento que la puso ahi.
--
-- CANTIDADES REPRODUCIBLES
-- Se calculan con una formula sobre el id del producto en lugar de usar
-- RAND(). Los datos tienen que dar siempre lo mismo: hay pruebas automaticas
-- que verifican totales concretos, y con cantidades al azar fallarian a veces.
-- =============================================================================

USE FerreplastDB;
GO

SET QUOTED_IDENTIFIER ON;
SET ANSI_NULLS ON;
GO

-- Se borra en orden inverso al de las dependencias.
DELETE FROM INTENTO_LOGIN;
DELETE FROM SESION;
DELETE FROM VENTA_LINEA;
-- Los movimientos apuntan a ventas: hay que soltarlos antes de borrar VENTA.
-- Es la unica excepcion permitida al trigger de inmutabilidad, y se consigue
-- desactivandolo explicitamente: una limpieza de datos de prueba no es una
-- correccion de historial.
DISABLE TRIGGER trg_movimientos_inmutables ON MOVIMIENTO_INVENTARIO;
DELETE FROM MOVIMIENTO_INVENTARIO;
ENABLE TRIGGER trg_movimientos_inmutables ON MOVIMIENTO_INVENTARIO;
DELETE FROM VENTA;
DELETE FROM CAJA;
DELETE FROM SYNC_LOG;
DELETE FROM DISPOSITIVO;
DELETE FROM Stock;
DELETE FROM Usuario;
DELETE FROM PRODUCTO;
DELETE FROM CATEGORIA;
DELETE FROM TIENDA;
DELETE FROM NEGOCIO;
GO

-- -----------------------------------------------------------------------------
-- Reinicia los contadores IDENTITY para que los ids sean los mismos en cada
-- carga. Sin esto, recargar los datos empezaria en 101, 201... y las pruebas
-- que nombran productos por id dejarian de encontrarlos.
--
-- CUIDADO -- TRAMPA DOCUMENTADA DE DBCC CHECKIDENT:
-- Si la tabla NUNCA tuvo filas, un RESEED a 0 hace que la primera insercion
-- tome el 0 como id, no el 1. Es decir que correr esto sobre una base recien
-- creada por schema.sql deja al negocio con id = 0, y todas las claves
-- foraneas que apuntan al 1 fallan.
--
-- Por eso solo se reinicia cuando la tabla YA tuvo filas (last_value no es
-- nulo). Si nunca las tuvo, el contador ya arranca en 1 y no hay nada que
-- hacer.
-- -----------------------------------------------------------------------------
DECLARE @tabla SYSNAME, @sql NVARCHAR(400);

DECLARE cur CURSOR LOCAL FAST_FORWARD FOR
    SELECT nombre FROM (VALUES
        ('NEGOCIO'), ('TIENDA'), ('CATEGORIA'), ('PRODUCTO'), ('Usuario'),
        ('DISPOSITIVO'), ('SYNC_LOG'), ('CAJA'), ('VENTA'),
        ('MOVIMIENTO_INVENTARIO'), ('INTENTO_LOGIN')
    ) AS t(nombre);

OPEN cur;
FETCH NEXT FROM cur INTO @tabla;

WHILE @@FETCH_STATUS = 0
BEGIN
    IF EXISTS (SELECT 1 FROM sys.identity_columns
                WHERE object_id = OBJECT_ID(@tabla) AND last_value IS NOT NULL)
    BEGIN
        SET @sql = N'DBCC CHECKIDENT (''' + @tabla + N''', RESEED, 0) WITH NO_INFOMSGS;';
        EXEC sp_executesql @sql;
    END
    FETCH NEXT FROM cur INTO @tabla;
END

CLOSE cur;
DEALLOCATE cur;
GO

-- -----------------------------------------------------------------------------
-- Negocio y tiendas
-- -----------------------------------------------------------------------------
INSERT INTO NEGOCIO (nombre, propietario, moneda) VALUES
('Ferreplast', 'Familia propietaria', 'NIO');

INSERT INTO TIENDA (negocio_id, nombre, tipo, direccion, prefijo) VALUES
(1, 'Ferreplast - Ferreteria',   'ferreteria',   'Modulo Principal',   'FER'),
(1, 'Ferreplast - Plastiqueria', 'plastiqueria', 'Modulo Secundario',  'PLA');
GO

-- -----------------------------------------------------------------------------
-- Categorias (1-5 ferreteria, 6-10 plastiqueria)
-- -----------------------------------------------------------------------------
INSERT INTO CATEGORIA (nombre, padre_id) VALUES
('Herramientas Manuales', NULL),      -- 1
('Materiales de Construccion', NULL), -- 2
('Plomeria', NULL),                   -- 3
('Pinturas y Solventes', NULL),       -- 4
('Electrico', NULL),                  -- 5
('Hogar y Cocina', NULL),             -- 6
('Limpieza', NULL),                   -- 7
('Jardineria', NULL),                 -- 8
('Desechables', NULL),                -- 9
('Organizacion', NULL);               -- 10
GO

-- =============================================================================
-- PRODUCTOS -- 50 de ferreteria (1-50) y 50 de plastiqueria (51-100)
--
-- Los precios son de venta, en cordobas. El COSTO se calcula abajo.
-- =============================================================================
INSERT INTO PRODUCTO (codigo, nombre, precio_venta, unidad_medida, categoria_id) VALUES
-- Herramientas Manuales (1)
('FER-001', 'Martillo de una Truper', 250.00, 'Unidad', 1),
('FER-002', 'Martillo de goma', 180.00, 'Unidad', 1),
('FER-003', 'Destornillador Plano 1/4"', 85.00, 'Unidad', 1),
('FER-004', 'Destornillador Phillips 1/4"', 85.00, 'Unidad', 1),
('FER-005', 'Alicate Universal 8"', 190.00, 'Unidad', 1),
('FER-006', 'Alicate de presion 10"', 210.00, 'Unidad', 1),
('FER-007', 'Llave ajustable (Cangreja) 10"', 220.00, 'Unidad', 1),
('FER-008', 'Cinta metrica 5m', 120.00, 'Unidad', 1),
('FER-009', 'Nivel de burbuja 24"', 150.00, 'Unidad', 1),
('FER-010', 'Serrucho para madera 20"', 195.00, 'Unidad', 1),
-- Materiales de Construccion (2)
('FER-011', 'Clavos de acero 2"', 45.00, 'Libra', 2),
('FER-012', 'Clavos de acero 3"', 45.00, 'Libra', 2),
('FER-013', 'Cemento Canal', 380.00, 'Bolsa', 2),
('FER-014', 'Arena fina', 600.00, 'Metro Cubico', 2),
('FER-015', 'Grava triturada', 650.00, 'Metro Cubico', 2),
('FER-016', 'Varilla de hierro 3/8"', 160.00, 'Varilla', 2),
('FER-017', 'Alambre de amarre', 35.00, 'Libra', 2),
('FER-018', 'Tornillo para madera 1" (100 und)', 60.00, 'Caja', 2),
('FER-019', 'Tuercas hexagonales 1/4" (50 und)', 40.00, 'Caja', 2),
('FER-020', 'Arandelas planas 1/4" (50 und)', 35.00, 'Caja', 2),
-- Plomeria (3)
('FER-021', 'Tubo PVC 1/2" SDR-26', 95.00, 'Tramo', 3),
('FER-022', 'Tubo PVC 3/4" SDR-26', 140.00, 'Tramo', 3),
('FER-023', 'Codo PVC 1/2"', 15.00, 'Unidad', 3),
('FER-024', 'Tee PVC 1/2"', 18.00, 'Unidad', 3),
('FER-025', 'Adaptador macho PVC 1/2"', 12.00, 'Unidad', 3),
('FER-026', 'Pegamento para PVC 1/4 Galon', 150.00, 'Unidad', 3),
('FER-027', 'Cinta Teflon 1/2"', 15.00, 'Unidad', 3),
('FER-028', 'Llave de pase bronce 1/2"', 145.00, 'Unidad', 3),
('FER-029', 'Grifo para lavandero', 110.00, 'Unidad', 3),
('FER-030', 'Sifon de acordeon plastico', 85.00, 'Unidad', 3),
-- Pinturas y Solventes (4)
('FER-031', 'Pintura Acrilica Blanca', 450.00, 'Galon', 4),
('FER-032', 'Pintura Acrilica Negra', 450.00, 'Galon', 4),
('FER-033', 'Pintura Anticorrosiva Gris', 520.00, 'Galon', 4),
('FER-034', 'Thinner Corriente', 65.00, 'Litro', 4),
('FER-035', 'Brocha de cerda natural 2"', 45.00, 'Unidad', 4),
('FER-036', 'Brocha de cerda natural 3"', 65.00, 'Unidad', 4),
('FER-037', 'Rodillo para pintar 9"', 90.00, 'Unidad', 4),
('FER-038', 'Bandeja plastica para pintura', 75.00, 'Unidad', 4),
('FER-039', 'Lija de agua #150', 10.00, 'Hoja', 4),
('FER-040', 'Espatula metalica 3"', 55.00, 'Unidad', 4),
-- Electrico (5)
('FER-041', 'Cable electrico #12 AWG', 12.00, 'Metro', 5),
('FER-042', 'Cable electrico #14 AWG', 9.00, 'Metro', 5),
('FER-043', 'Toma corriente doble', 65.00, 'Unidad', 5),
('FER-044', 'Apagador sencillo', 55.00, 'Unidad', 5),
('FER-045', 'Cinta aislante negra (Super 33)', 80.00, 'Unidad', 5),
('FER-046', 'Bombillo LED 9W', 45.00, 'Unidad', 5),
('FER-047', 'Socate de porcelana', 35.00, 'Unidad', 5),
('FER-048', 'Breaker 20A', 140.00, 'Unidad', 5),
('FER-049', 'Caja termica para 2 breakers', 250.00, 'Unidad', 5),
('FER-050', 'Tubo Conduit PVC 1/2"', 65.00, 'Tramo', 5);

INSERT INTO PRODUCTO (codigo, nombre, precio_venta, unidad_medida, categoria_id) VALUES
-- Hogar y Cocina (6)
('PLA-001', 'Silla plastica con brazos (Blanca)', 350.00, 'Unidad', 6),
('PLA-002', 'Mesa plastica cuadrada (Blanca)', 850.00, 'Unidad', 6),
('PLA-003', 'Plato hondo de plastico grueso', 35.00, 'Unidad', 6),
('PLA-004', 'Plato plano de plastico grueso', 35.00, 'Unidad', 6),
('PLA-005', 'Vaso plastico reutilizable 250ml', 15.00, 'Unidad', 6),
('PLA-006', 'Jarra plastica para jugo 2L', 70.00, 'Unidad', 6),
('PLA-007', 'Cucharon de plastico', 25.00, 'Unidad', 6),
('PLA-008', 'Contenedor hermetico 1 Litro', 65.00, 'Unidad', 6),
('PLA-009', 'Contenedor hermetico 2.5 Litros', 110.00, 'Unidad', 6),
('PLA-010', 'Escurridor de platos plastico', 220.00, 'Unidad', 6),
-- Limpieza (7)
('PLA-011', 'Balde plastico 10 Litros', 75.00, 'Unidad', 7),
('PLA-012', 'Balde plastico 20 Litros', 120.00, 'Unidad', 7),
('PLA-013', 'Basurero con pedal mediano', 250.00, 'Unidad', 7),
('PLA-014', 'Basurero de vaiven grande', 320.00, 'Unidad', 7),
('PLA-015', 'Recogedor de basura con mango', 45.00, 'Unidad', 7),
('PLA-016', 'Cepillo de lavar ropa', 20.00, 'Unidad', 7),
('PLA-017', 'Huacal plastico grande', 90.00, 'Unidad', 7),
('PLA-018', 'Cesto canasta para ropa sucia', 280.00, 'Unidad', 7),
('PLA-019', 'Dispensador de jabon liquido', 55.00, 'Unidad', 7),
('PLA-020', 'Balde escurridor para trapeador', 450.00, 'Unidad', 7),
-- Jardineria (8)
('PLA-021', 'Macetera plastica pequena', 40.00, 'Unidad', 8),
('PLA-022', 'Macetera plastica mediana', 85.00, 'Unidad', 8),
('PLA-023', 'Macetera plastica grande', 160.00, 'Unidad', 8),
('PLA-024', 'Macetera rectangular tipo jardinera', 130.00, 'Unidad', 8),
('PLA-025', 'Regadera plastica 5L', 140.00, 'Unidad', 8),
('PLA-026', 'Manguera plastica verde 15m', 350.00, 'Unidad', 8),
('PLA-027', 'Aspersor plastico de estaca', 80.00, 'Unidad', 8),
('PLA-028', 'Rastrillo plastico para hojas', 110.00, 'Unidad', 8),
('PLA-029', 'Mini cerca plastica decorativa', 45.00, 'Unidad', 8),
('PLA-030', 'Base con ruedas para maceta', 190.00, 'Unidad', 8),
-- Desechables (9)
('PLA-031', 'Vasos desechables 8oz (100 und)', 75.00, 'Paquete', 9),
('PLA-032', 'Platos desechables #9 (100 und)', 110.00, 'Paquete', 9),
('PLA-033', 'Cucharas desechables (100 und)', 50.00, 'Paquete', 9),
('PLA-034', 'Tenedores desechables (100 und)', 50.00, 'Paquete', 9),
('PLA-035', 'Pajillas plasticas (100 und)', 35.00, 'Paquete', 9),
('PLA-036', 'Bolsas de basura pequenas (50 und)', 40.00, 'Paquete', 9),
('PLA-037', 'Bolsas de basura grandes (50 und)', 90.00, 'Paquete', 9),
('PLA-038', 'Envases Clamshell p/comida (50 und)', 160.00, 'Paquete', 9),
('PLA-039', 'Tapas planas para vasos (100 und)', 45.00, 'Paquete', 9),
('PLA-040', 'Platos termicos de poroplast (50 und)', 80.00, 'Paquete', 9),
-- Organizacion (10)
('PLA-041', 'Organizador de gavetas 3 niveles', 320.00, 'Unidad', 10),
('PLA-042', 'Caja plastica organizadora 10L c/tapa', 150.00, 'Unidad', 10),
('PLA-043', 'Caja plastica organizadora 20L c/tapa', 280.00, 'Unidad', 10),
('PLA-044', 'Caja plastica organizadora 50L c/ruedas', 650.00, 'Unidad', 10),
('PLA-045', 'Estante plastico de 3 niveles', 580.00, 'Unidad', 10),
('PLA-046', 'Estante plastico de 4 niveles', 750.00, 'Unidad', 10),
('PLA-047', 'Perchas plasticas para ropa (12 und)', 85.00, 'Docena', 10),
('PLA-048', 'Cesto organizador pequeno calado', 35.00, 'Unidad', 10),
('PLA-049', 'Zapatera plastica armable', 240.00, 'Unidad', 10),
('PLA-050', 'Mini gavetero de escritorio', 180.00, 'Unidad', 10);
GO

-- -----------------------------------------------------------------------------
-- Costo de cada producto
--
-- El margen varia por rubro, como en la realidad: el cemento y la arena se
-- venden con margen fino porque el precio lo fija el mercado y el cliente lo
-- conoce; los plasticos de organizacion y la loza aguantan mas.
--
-- Son valores inventados para poder probar los reportes de ganancia. Al cargar
-- datos reales hay que reemplazarlos por los costos de factura del proveedor.
-- -----------------------------------------------------------------------------
UPDATE PRODUCTO
   SET precio_costo = ROUND(precio_venta * CASE categoria_id
        WHEN 1  THEN 0.60   -- Herramientas Manuales
        WHEN 2  THEN 0.80   -- Materiales de Construccion
        WHEN 3  THEN 0.65   -- Plomeria
        WHEN 4  THEN 0.70   -- Pinturas y Solventes
        WHEN 5  THEN 0.68   -- Electrico
        WHEN 6  THEN 0.58   -- Hogar y Cocina
        WHEN 7  THEN 0.60   -- Limpieza
        WHEN 8  THEN 0.62   -- Jardineria
        WHEN 9  THEN 0.75   -- Desechables
        WHEN 10 THEN 0.57   -- Organizacion
       END, 2);
GO

-- -----------------------------------------------------------------------------
-- Usuarios
--
-- NUNCA se guarda un PIN o contrasenia en texto plano: lo que va en la base es
-- el hash scrypt, con su sal y sus parametros adentro (ver src/auth/password.mjs).
--
-- CREDENCIALES DE PRUEBA -- solo para desarrollo local.
-- Son publicas a proposito: estan en el repositorio para que cualquiera pueda
-- levantar el proyecto y entrar. Al cargar datos reales hay que crear los
-- usuarios de verdad y borrar estas tres filas.
--
--   Carlos Admin          admin@ferreplast.com   contrasenia: ferreplast2026
--   Juan Ferreteria       (PIN en la tablet)     PIN: 1234
--   Maria Plastiqueria    (PIN en la tablet)     PIN: 5678
--
-- Para regenerar estos hash:
--   node --input-type=module -e "import {hashear} from './src/auth/password.mjs'; console.log(await hashear('loquesea'))"
--
-- El administrador tiene tienda_id NULL: no pertenece a un local, ve los dos.
-- -----------------------------------------------------------------------------
INSERT INTO Usuario (negocio_id, tienda_id, nombre, rol, email, password_hash, pin_hash) VALUES
(1, NULL, 'Carlos Admin', 'admin', 'admin@ferreplast.com',
 'scrypt$16384$8$1$Dqh3JaASO5NwNKaI+I+eLA==$8ZUSwEVybue0Y/N0wAERopYhTm3W5sW1fgO0wMMrB89pM2eOZ6u/GKjhGulYkauyTquCLDrhweYayJW0aYzg2w==',
 NULL),
(1, 1, 'Juan Ferreteria', 'empleado', NULL, NULL,
 'scrypt$16384$8$1$DHu4I9gFIz+AdUtwPFQUlw==$bsVbQh6U3xMTPdarVYh0maBnL2r86B2ZMfxbeofAJqfS7D+L2OVGQ+gdt+LORTZdKuFc+Ua7LkA3Mnt6w/zpsQ=='),
(1, 2, 'Maria Plastiqueria', 'empleado', NULL, NULL,
 'scrypt$16384$8$1$3ddyfhlIMTmV6/jby6EbCQ==$S9Fmbw2PrI9yYuSOIIVguivm9myNBVBIw29hjDn3Aw5rDr5asRtDtdz3K/Nrrjkh7tamdWkEtbecoVzlc/A2QQ==');
GO

-- -----------------------------------------------------------------------------
-- Dispositivos y bitacora de sincronizacion
-- -----------------------------------------------------------------------------
INSERT INTO DISPOSITIVO (tienda_id, nombre, ultimo_sync) VALUES
(1, 'Caja Principal - Ferreteria',   SYSUTCDATETIME()),
(2, 'Caja Principal - Plastiqueria', SYSUTCDATETIME()),
(1, 'Tablet Inventario Bodega',      DATEADD(HOUR, -5, SYSUTCDATETIME()));

INSERT INTO SYNC_LOG (dispositivo_id, registros_enviados, registros_aceptados, registros_duplicados) VALUES
(1, 150, 150, 0),
(2,  85,  83, 2),
(3,  40,  40, 0);
GO

-- =============================================================================
-- INVENTARIO INICIAL
--
-- Una entrada de mercaderia por producto. El trigger trg_movimiento_actualiza_stock
-- crea las filas de Stock a partir de estos movimientos: no se tocan a mano.
--
-- Cada tienda recibe solo su rubro (1-50 ferreteria, 51-100 plastiqueria), que
-- es lo que define el catalogo de cada local.
-- =============================================================================
INSERT INTO MOVIMIENTO_INVENTARIO
       (tienda_id, producto_id, usuario_id, tipo, cantidad, costo_unitario, motivo, ocurrido_en)
SELECT 1, p.id, 2, 'entrada',
       50 + (p.id % 11) * 10,          -- entre 50 y 150, reproducible
       p.precio_costo,
       'Inventario inicial',
       DATEADD(DAY, -30, SYSUTCDATETIME())
  FROM PRODUCTO p
 WHERE p.id BETWEEN 1 AND 50;

INSERT INTO MOVIMIENTO_INVENTARIO
       (tienda_id, producto_id, usuario_id, tipo, cantidad, costo_unitario, motivo, ocurrido_en)
SELECT 2, p.id, 3, 'entrada',
       50 + (p.id % 11) * 10,
       p.precio_costo,
       'Inventario inicial',
       DATEADD(DAY, -30, SYSUTCDATETIME())
  FROM PRODUCTO p
 WHERE p.id BETWEEN 51 AND 100;
GO

-- Punto de reposicion. Se deja alto en tres articulos para que la pantalla de
-- alertas tenga algo que mostrar en la demostracion.
UPDATE Stock SET cantidad_minima = 10;

UPDATE Stock SET cantidad_minima = 200
 WHERE producto_id IN (13, 51)          -- Cemento Canal, Silla plastica
    OR (tienda_id = 1 AND producto_id = 41);   -- Cable electrico #12
GO

-- =============================================================================
-- OPERACION DEL DIA
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Cajas (turnos)
--
-- Caja 1: Juan en ferreteria. Abrio con 1000, vendio 880 en efectivo, conto
--         1880 al cerrar. Cuadre perfecto.
-- Caja 2: Maria en plastiqueria. Abrio con 500, su unica venta fue con tarjeta
--         (no entra efectivo), conto 450. Faltan 50 cordobas.
--
-- La columna 'diferencia' guarda lo que se anoto al arquear. La vista
-- v_cuadre_caja recalcula lo esperado desde las ventas y permite comprobar si
-- ese numero sigue siendo cierto.
-- -----------------------------------------------------------------------------
INSERT INTO CAJA (tienda_id, usuario_id, monto_inicial, efectivo_contado, diferencia,
                  estado, abierta_en, cerrada_en) VALUES
(1, 2, 1000.00, 1880.00,   0.00, 'cerrada',
 DATEADD(HOUR, -9, SYSUTCDATETIME()), DATEADD(HOUR, -1, SYSUTCDATETIME())),
(2, 3,  500.00,  450.00, -50.00, 'cerrada',
 DATEADD(HOUR, -9, SYSUTCDATETIME()), DATEADD(HOUR, -1, SYSUTCDATETIME()));
GO

-- -----------------------------------------------------------------------------
-- Ventas
--
-- El numero es correlativo POR TIENDA; el comprobante legible se arma con el
-- prefijo ('FER-1001', 'PLA-2001').
-- -----------------------------------------------------------------------------
INSERT INTO VENTA (uuid_externo, tienda_id, usuario_id, caja_id, numero,
                   subtotal, descuento, total, metodo_pago, ocurrido_en) VALUES
('11111111-1111-1111-1111-000000001001', 1, 2, 1, 1001,
  880.00,  0.00,  880.00, 'efectivo', DATEADD(HOUR, -4, SYSUTCDATETIME())),
('11111111-1111-1111-1111-000000002001', 2, 3, 2, 2001,
 1200.00, 50.00, 1150.00, 'tarjeta',  DATEADD(HOUR, -3, SYSUTCDATETIME()));
GO

-- -----------------------------------------------------------------------------
-- Lineas de venta
--
-- El costo se toma del producto EN ESTE MOMENTO y queda congelado en la linea.
-- Si manana sube el costo del cemento, esta venta sigue mostrando lo que de
-- verdad se gano el dia que ocurrio.
-- -----------------------------------------------------------------------------
INSERT INTO VENTA_LINEA (venta_id, numero, producto_id, cantidad, precio_unitario, costo_unitario, subtotal)
SELECT 1, 1, p.id, 2.000, p.precio_venta, p.precio_costo, ROUND(2 * p.precio_venta, 2)
  FROM PRODUCTO p WHERE p.id = 1;      -- 2 martillos
INSERT INTO VENTA_LINEA (venta_id, numero, producto_id, cantidad, precio_unitario, costo_unitario, subtotal)
SELECT 1, 2, p.id, 1.000, p.precio_venta, p.precio_costo, ROUND(1 * p.precio_venta, 2)
  FROM PRODUCTO p WHERE p.id = 13;     -- 1 bolsa de cemento

INSERT INTO VENTA_LINEA (venta_id, numero, producto_id, cantidad, precio_unitario, costo_unitario, subtotal)
SELECT 2, 1, p.id, 1.000, p.precio_venta, p.precio_costo, ROUND(1 * p.precio_venta, 2)
  FROM PRODUCTO p WHERE p.id = 51;     -- 1 silla
INSERT INTO VENTA_LINEA (venta_id, numero, producto_id, cantidad, precio_unitario, costo_unitario, subtotal)
SELECT 2, 2, p.id, 1.000, p.precio_venta, p.precio_costo, ROUND(1 * p.precio_venta, 2)
  FROM PRODUCTO p WHERE p.id = 52;     -- 1 mesa
GO

-- -----------------------------------------------------------------------------
-- Movimientos derivados de las ventas
--
-- Se generan DESDE las lineas, no se escriben a mano: asi es imposible que una
-- venta exista sin su descuento de stock.
--
-- La cantidad va en NEGATIVO. La restriccion CK_MOVIMIENTO_SIGNO lo exige, y
-- es lo que hace que sumar los movimientos de un producto de el stock correcto.
-- -----------------------------------------------------------------------------
INSERT INTO MOVIMIENTO_INVENTARIO
       (tienda_id, producto_id, usuario_id, venta_id, tipo, cantidad, costo_unitario, motivo, ocurrido_en)
SELECT v.tienda_id, l.producto_id, v.usuario_id, v.id, 'venta',
       -l.cantidad, l.costo_unitario,
       CONCAT('Salida por comprobante ', t.prefijo, '-', v.numero),
       v.ocurrido_en
  FROM VENTA_LINEA l
  JOIN VENTA  v ON v.id = l.venta_id
  JOIN TIENDA t ON t.id = v.tienda_id;
GO

-- -----------------------------------------------------------------------------
-- Otros movimientos sueltos
-- -----------------------------------------------------------------------------
INSERT INTO MOVIMIENTO_INVENTARIO
       (tienda_id, producto_id, usuario_id, tipo, cantidad, costo_unitario, motivo, ocurrido_en)
VALUES
-- Compra a proveedor
(1, 11, 2, 'entrada',  50.000, 36.00, 'Ingreso de mercaderia - Proveedor X', DATEADD(HOUR, -6, SYSUTCDATETIME())),
-- Rotura en bodega
(2, 55, 3, 'merma',    -1.000,  8.70, 'Vaso plastico roto en bodega',        DATEADD(HOUR, -2, SYSUTCDATETIME())),
-- Correccion tras conteo fisico: el historial no se edita, se compensa
(1,  3, 2, 'ajuste',   -2.000, 51.00, 'Faltante detectado en conteo fisico', DATEADD(HOUR, -1, SYSUTCDATETIME()));
GO

PRINT 'Datos de prueba cargados.';
GO
