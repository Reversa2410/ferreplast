-- =============================================================================
-- FERREPLAST -- Esquema de base de datos
-- Sistema de gestion para ferreteria y plastiqueria
--
-- Motor: Microsoft SQL Server 2019+ (T-SQL)
--
-- Este archivo es idempotente: se puede ejecutar varias veces seguidas.
--   sqlcmd -S localhost -E -C -f 65001 -i db/schema.sql
--
-- SOBRE LOS LOTES (GO)
-- Cada bloque termina en GO a proposito. SQL Server compila un lote COMPLETO
-- antes de ejecutar una sola de sus lineas: sin separadores, un error de
-- sintaxis en la ultima consulta impide que se cree la primera tabla, y el
-- script falla entero sin dejar rastro de por donde iba.
-- =============================================================================

IF DB_ID('FerreplastDB') IS NULL
    CREATE DATABASE FerreplastDB;
GO

USE FerreplastDB;
GO

-- -----------------------------------------------------------------------------
-- OPCIONES DE SESION -- obligatorias, no decorativas.
--
-- Los indices FILTRADOS (los que llevan WHERE) y las vistas indexadas exigen
-- QUOTED_IDENTIFIER y ANSI_NULLS en ON. SSMS los pone asi por omision, pero
-- sqlcmd NO: el mismo script que funciona apretando F5 falla desde la linea de
-- comandos con "CREATE INDEX failed because the following SET options have
-- incorrect settings". Declararlas aca hace que el resultado no dependa de con
-- que herramienta se ejecute.
--
-- Ademas quedan grabadas en cada vista, trigger y procedimiento que se cree a
-- continuacion: SQL Server captura estas opciones en el momento de crearlos.
-- -----------------------------------------------------------------------------
SET QUOTED_IDENTIFIER ON;
SET ANSI_NULLS ON;
GO

-- -----------------------------------------------------------------------------
-- 0. LIMPIEZA (solo desarrollo -- NUNCA correr esto en produccion)
--
-- El orden es inverso al de creacion: no se puede borrar una tabla a la que
-- otra todavia apunta con una clave foranea.
-- -----------------------------------------------------------------------------
DROP VIEW  IF EXISTS v_cuentas_por_cobrar;
DROP VIEW  IF EXISTS v_cuadre_caja;
DROP VIEW  IF EXISTS v_alertas_stock;
DROP VIEW  IF EXISTS v_ventas_diarias;
DROP VIEW  IF EXISTS v_inventario_valorizado;

DROP TABLE IF EXISTS INTENTO_LOGIN;
DROP TABLE IF EXISTS SESION;
DROP TABLE IF EXISTS USUARIO_TIENDA;
DROP TABLE IF EXISTS PAGO_CREDITO;
DROP TABLE IF EXISTS VENTA_LINEA;
-- MOVIMIENTO_INVENTARIO va antes que VENTA: le apunta con FK_MOV_VENTA. Al
-- reves el DROP falla y el script deja de ser idempotente, que es justo lo que
-- promete la cabecera de este archivo.
DROP TABLE IF EXISTS MOVIMIENTO_INVENTARIO;
DROP TABLE IF EXISTS VENTA;
DROP TABLE IF EXISTS CLIENTE;
DROP TABLE IF EXISTS CAJA;
DROP TABLE IF EXISTS SYNC_LOG;
DROP TABLE IF EXISTS DISPOSITIVO;
DROP TABLE IF EXISTS Stock;
DROP TABLE IF EXISTS Usuario;
DROP TABLE IF EXISTS PRODUCTO;
DROP TABLE IF EXISTS CATEGORIA;
DROP TABLE IF EXISTS TIENDA;
DROP TABLE IF EXISTS NEGOCIO;
GO

-- =============================================================================
-- 1. CONVENCIONES
--
-- SIN TIPOS ENUMERADOS. PostgreSQL permite declarar un tipo ENUM; SQL Server
-- no. El equivalente es una restriccion CHECK con la lista de valores, que da
-- la misma garantia (la base rechaza un valor fuera de la lista) con dos
-- diferencias: el valor valido no se puede consultar desde el catalogo del
-- sistema tan comodamente, y agregar uno exige ALTER TABLE en lugar de
-- ALTER TYPE. Para listas que cambian seguido -- las categorias de producto --
-- se usa una TABLA con clave foranea, que es el otro lado del compromiso.
--
-- DECIMAL, NUNCA FLOAT. Un FLOAT no puede representar 0.10 exactamente, asi
-- que sumar cien veces diez centavos no da diez. En dinero e inventario eso es
-- inaceptable. DECIMAL(18,2) para importes y DECIMAL(18,3) para cantidades
-- (hay productos que se venden por metro y por libra).
--
-- FECHAS EN UTC. Todas las columnas de fecha son DATETIME2 y guardan UTC, con
-- SYSUTCDATETIME() como valor por omision. La conversion a la hora local pasa
-- al mostrar. Guardar hora local es el origen clasico del reporte que cambia
-- segun quien lo abre.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 2.1 NEGOCIO
--
-- Hoy tiene una sola fila y parece sobrar. Esta por una razon concreta: el
-- sistema se piensa para venderlo a otras familias. Con esta tabla, sumar un
-- cliente es insertar una fila; sin ella habria que agregar la nocion de "a
-- quien pertenece esto" a tablas ya cargadas con datos de produccion, que es
-- una de las migraciones mas caras que existen.
-- -----------------------------------------------------------------------------
CREATE TABLE NEGOCIO (
    id          INT           IDENTITY(1,1) PRIMARY KEY,
    nombre      VARCHAR(100)  NOT NULL,
    propietario VARCHAR(100),
    moneda      VARCHAR(10)   NOT NULL DEFAULT 'NIO',
    -- BIT y no VARCHAR 'si'/'no': un booleano guardado como texto admite 'Si',
    -- 'SI', 'S', 'true' y el dia que alguien escriba uno distinto, la consulta
    -- que filtra activo = 'si' deja de ver esa fila sin avisar.
    activo      BIT           NOT NULL DEFAULT 1,
    created_at  DATETIME2(3)  NOT NULL DEFAULT SYSUTCDATETIME()
);
GO

-- -----------------------------------------------------------------------------
-- 2.2 TIENDA
-- -----------------------------------------------------------------------------
CREATE TABLE TIENDA (
    id         INT           IDENTITY(1,1) PRIMARY KEY,
    negocio_id INT           NOT NULL,
    nombre     VARCHAR(100)  NOT NULL,
    tipo       VARCHAR(50)   NOT NULL,
    direccion  VARCHAR(255),
    -- Prefijo del comprobante: 'FER', 'PLA'. El numero de factura legible se
    -- arma al mostrar (prefijo + numero), asi no se guarda dos veces.
    prefijo    VARCHAR(10)   NOT NULL,
    activo     BIT           NOT NULL DEFAULT 1,
    created_at DATETIME2(3)  NOT NULL DEFAULT SYSUTCDATETIME(),

    CONSTRAINT FK_TIENDA_NEGOCIO FOREIGN KEY (negocio_id) REFERENCES NEGOCIO(id),
    CONSTRAINT CK_TIENDA_TIPO CHECK (tipo IN ('ferreteria', 'plastiqueria', 'otro'))
);

CREATE INDEX IX_TIENDA_NEGOCIO ON TIENDA(negocio_id);
GO

-- -----------------------------------------------------------------------------
-- 2.3 CATEGORIA
--
-- Jerarquia simple por auto-referencia: "Plomeria" puede contener "Tuberias
-- PVC". Con padre_id NULL la categoria es de primer nivel.
-- -----------------------------------------------------------------------------
CREATE TABLE CATEGORIA (
    id       INT          IDENTITY(1,1) PRIMARY KEY,
    nombre   VARCHAR(100) NOT NULL,
    padre_id INT NULL,

    CONSTRAINT FK_CATEGORIA_PADRE FOREIGN KEY (padre_id) REFERENCES CATEGORIA(id),
    -- Una categoria no puede ser su propia madre. No alcanza para impedir un
    -- ciclo largo (A -> B -> A), pero si el error que de verdad ocurre.
    CONSTRAINT CK_CATEGORIA_NO_SE_CONTIENE CHECK (padre_id <> id)
);
GO

-- -----------------------------------------------------------------------------
-- 2.4 PRODUCTO
--
-- DOS PRECIOS, NO UNO.
-- Tener una sola columna de precio obliga a elegir: o se guarda lo que cuesta
-- o lo que se cobra. Con cualquiera de las dos sola, la pregunta que el duenio
-- no puede contestar hoy -- "cuanto GANE", no "cuanto vendi" -- sigue sin
-- respuesta, y el inventario no se puede valorizar a costo.
--
-- El producto pertenece al NEGOCIO, no a una tienda: corregir un nombre o un
-- precio se hace en un solo lugar y vale para las dos. Lo que varia por tienda
-- es el stock, y el catalogo de cada tienda es el conjunto de productos que
-- tienen fila en Stock para ella.
-- -----------------------------------------------------------------------------
CREATE TABLE PRODUCTO (
    id            INT           IDENTITY(1,1) PRIMARY KEY,
    codigo        VARCHAR(50),
    nombre        VARCHAR(150)  NOT NULL,
    categoria_id  INT           NOT NULL,
    precio_costo  DECIMAL(18,2) NOT NULL DEFAULT 0.00,
    precio_venta  DECIMAL(18,2) NOT NULL DEFAULT 0.00,
    -- 'Unidad', 'Libra', 'Metro', 'Galon'. Hay productos que no se venden de a
    -- uno: por eso las cantidades admiten decimales.
    unidad_medida VARCHAR(50)   NOT NULL DEFAULT 'Unidad',
    activo        BIT           NOT NULL DEFAULT 1,
    created_at    DATETIME2(3)  NOT NULL DEFAULT SYSUTCDATETIME(),
    updated_at    DATETIME2(3)  NOT NULL DEFAULT SYSUTCDATETIME(),

    CONSTRAINT FK_PRODUCTO_CATEGORIA FOREIGN KEY (categoria_id) REFERENCES CATEGORIA(id),
    CONSTRAINT CK_PRODUCTO_PRECIOS CHECK (precio_costo >= 0 AND precio_venta >= 0)
);

-- El codigo es opcional (hoy los productos no vienen con ninguno), pero si
-- existe no puede repetirse. El indice unico FILTRADO permite muchos NULL y a
-- la vez prohibe dos veces el mismo codigo: una restriccion UNIQUE comun en
-- SQL Server solo admitiria UN NULL en toda la tabla.
CREATE UNIQUE INDEX UX_PRODUCTO_CODIGO ON PRODUCTO(codigo) WHERE codigo IS NOT NULL;
CREATE INDEX IX_PRODUCTO_CATEGORIA ON PRODUCTO(categoria_id);
-- Busqueda por nombre en el mostrador. SQL Server no tiene un indice de
-- trigramas como pg_trgm, asi que un indice comun sirve para 'empieza con';
-- para buscar por el medio ('%tornillo%') haria falta FULLTEXT.
CREATE INDEX IX_PRODUCTO_NOMBRE ON PRODUCTO(nombre);
GO

-- -----------------------------------------------------------------------------
-- 2.5 CLIENTE
--
-- Existe porque el negocio FIA. Sin esta tabla se puede registrar una venta
-- con metodo_pago = 'credito' y no queda asentado a quien se le fio: el
-- sistema no sabe contestar "quien me debe y cuanto", que para un negocio que
-- da credito es LA pregunta.
--
-- El cliente cuelga de NEGOCIO y no de TIENDA: la duenia es una sola y la
-- plata es la misma, asi que el limite es el total que la persona puede deber
-- entre la ferreteria y la plastiqueria, no uno por local.
--
-- EL SALDO NO SE GUARDA. Se deriva de las ventas a credito menos los abonos,
-- por el mismo motivo que el stock: un saldo escrito a mano se desincroniza y,
-- ademas, anular una venta fiada tendria que acordarse de restarlo. Derivado,
-- se corrige solo.
-- -----------------------------------------------------------------------------
CREATE TABLE CLIENTE (
    id             INT           IDENTITY(1,1) PRIMARY KEY,
    negocio_id     INT           NOT NULL,
    nombre         VARCHAR(150)  NOT NULL,
    telefono       VARCHAR(30),
    identificacion VARCHAR(30),
    -- Valor por omision, no constante del sistema: antes o despues le van a
    -- querer subir el cupo a alguien, y si el numero vive en el codigo eso se
    -- convierte en un pedido de cambio.
    limite_credito DECIMAL(18,2) NOT NULL DEFAULT 1000.00,
    activo         BIT           NOT NULL DEFAULT 1,
    created_at     DATETIME2(3)  NOT NULL DEFAULT SYSUTCDATETIME(),

    CONSTRAINT FK_CLIENTE_NEGOCIO FOREIGN KEY (negocio_id) REFERENCES NEGOCIO(id),
    CONSTRAINT CK_CLIENTE_LIMITE  CHECK (limite_credito >= 0)
);

-- La cedula es opcional (muchos clientes del mostrador no la dan) pero si esta
-- no puede repetirse: dos fichas de la misma persona parten la deuda en dos y
-- el limite deja de valer.
CREATE UNIQUE INDEX UX_CLIENTE_IDENTIFICACION ON CLIENTE(identificacion)
    WHERE identificacion IS NOT NULL;
CREATE INDEX IX_CLIENTE_NOMBRE ON CLIENTE(nombre) WHERE activo = 1;
GO

-- -----------------------------------------------------------------------------
-- 2.6 Usuario
--
-- Dos roles, no mas: empleado y administrador. Son las dos unicas situaciones
-- reales del negocio, y cada una entra distinto:
--   * empleado      -> PIN corto en la tablet (se teclea cincuenta veces al dia)
--   * administrador -> email + contrasenia en el panel web
--
-- Se guarda el HASH, nunca el PIN ni la contrasenia en claro.
--
-- El usuario NO tiene tienda_id. Un empleado puede trabajar en las dos tiendas
-- (lo dice el levantamiento), asi que la pertenencia vive en USUARIO_TIENDA y
-- la tienda desde la que esta operando AHORA vive en SESION. Son dos cosas
-- distintas: a donde pertenece, y desde donde esta vendiendo hoy.
-- -----------------------------------------------------------------------------
CREATE TABLE Usuario (
    id            INT           IDENTITY(1,1) PRIMARY KEY,
    negocio_id    INT           NOT NULL,
    nombre        VARCHAR(100)  NOT NULL,
    rol           VARCHAR(20)   NOT NULL DEFAULT 'empleado',
    email         VARCHAR(150),
    password_hash VARCHAR(255),
    pin_hash      VARCHAR(255),
    activo        BIT           NOT NULL DEFAULT 1,
    ultimo_acceso DATETIME2(3),
    created_at    DATETIME2(3)  NOT NULL DEFAULT SYSUTCDATETIME(),

    CONSTRAINT FK_USUARIO_NEGOCIO FOREIGN KEY (negocio_id) REFERENCES NEGOCIO(id),
    CONSTRAINT CK_USUARIO_ROL CHECK (rol IN ('empleado', 'administrador')),

    -- La regla de negocio vive en la BASE, no solo en el codigo de la app.
    -- Sin esto se pueden crear usuarios que no pueden entrar por ningun lado, y
    -- el error aparece recien cuando esa persona intenta trabajar.
    --
    -- Ya no se exige tienda: un CHECK no puede mirar otra tabla y la
    -- pertenencia se mudo a USUARIO_TIENDA. Esa garantia baja al codigo, y es
    -- el costo consciente de admitir empleados compartidos.
    CONSTRAINT CK_USUARIO_CREDENCIALES CHECK (
        (rol = 'administrador' AND email IS NOT NULL AND password_hash IS NOT NULL)
     OR (rol = 'empleado'      AND pin_hash IS NOT NULL)
    )
);

-- Mismo motivo que el codigo de producto: el email es opcional (los empleados
-- no tienen) pero no se puede repetir.
CREATE UNIQUE INDEX UX_USUARIO_EMAIL ON Usuario(email) WHERE email IS NOT NULL;
GO

-- -----------------------------------------------------------------------------
-- 2.7 USUARIO_TIENDA
--
-- En que tiendas puede trabajar cada empleado. El levantamiento dice que
-- "algunos empleados trabajan en ambas tiendas a la vez": con un solo
-- tienda_id en Usuario eso era inexpresable, y la salida practica -- crear dos
-- usuarios para la misma persona -- parte en dos cualquier reporte de "cuanto
-- vendio Fulano" y le deja dos PIN distintos.
--
-- El administrador no tiene filas aca: ver las dos tiendas es justamente no
-- pertenecer a ninguna.
-- -----------------------------------------------------------------------------
CREATE TABLE USUARIO_TIENDA (
    usuario_id INT          NOT NULL,
    tienda_id  INT          NOT NULL,
    created_at DATETIME2(3) NOT NULL DEFAULT SYSUTCDATETIME(),

    CONSTRAINT PK_USUARIO_TIENDA PRIMARY KEY (usuario_id, tienda_id),
    -- ON DELETE CASCADE: si se borra el usuario, sus asignaciones no significan
    -- nada por separado. No es el caso de sus ventas, que se conservan.
    CONSTRAINT FK_USUTIENDA_USUARIO FOREIGN KEY (usuario_id) REFERENCES Usuario(id) ON DELETE CASCADE,
    CONSTRAINT FK_USUTIENDA_TIENDA  FOREIGN KEY (tienda_id)  REFERENCES TIENDA(id)
);

-- La pantalla de ingreso pregunta siempre "que empleados trabajan en esta
-- tienda", asi que el indice va por tienda.
CREATE INDEX IX_USUTIENDA_TIENDA ON USUARIO_TIENDA(tienda_id);
GO

-- -----------------------------------------------------------------------------
-- 2.8 Stock -- CACHE, NO VERDAD
--
-- Guarda el total ya calculado para que la pantalla de venta no tenga que
-- sumar miles de movimientos cada vez que el empleado toca una tecla.
--
-- La VERDAD siempre es MOVIMIENTO_INVENTARIO. Esta tabla la mantiene al dia un
-- trigger. Si se desalinea, se regenera (ver seccion 5).
--
-- Clave primaria compuesta (tienda_id, producto_id): hace imposible por diseno
-- que existan dos filas contradictorias para el mismo par.
-- -----------------------------------------------------------------------------
CREATE TABLE Stock (
    tienda_id       INT           NOT NULL,
    producto_id     INT           NOT NULL,
    cantidad        DECIMAL(18,3) NOT NULL DEFAULT 0,
    cantidad_minima DECIMAL(18,3) NOT NULL DEFAULT 0,
    updated_at      DATETIME2(3)  NOT NULL DEFAULT SYSUTCDATETIME(),

    -- COLUMNA CALCULADA Y PERSISTIDA.
    --
    -- Existe por una limitacion concreta: en PostgreSQL se puede crear un
    -- indice parcial con WHERE cantidad <= cantidad_minima, pero SQL Server
    -- NO admite comparar dos columnas en el filtro de un indice filtrado
    -- (solo columna contra constante). El intento falla con
    -- "Incorrect WHERE clause for filtered index".
    --
    -- La vuelta es calcular la comparacion una sola vez, guardarla (PERSISTED)
    -- e indexarla. Al ser calculada no se puede escribir a mano, asi que es
    -- imposible que diga que un producto esta bien de stock cuando no lo esta.
    necesita_reposicion AS (CASE WHEN cantidad <= cantidad_minima THEN 1 ELSE 0 END) PERSISTED,

    CONSTRAINT PK_STOCK PRIMARY KEY (tienda_id, producto_id),
    CONSTRAINT FK_STOCK_TIENDA   FOREIGN KEY (tienda_id)   REFERENCES TIENDA(id),
    CONSTRAINT FK_STOCK_PRODUCTO FOREIGN KEY (producto_id) REFERENCES PRODUCTO(id),
    CONSTRAINT CK_STOCK_MINIMA CHECK (cantidad_minima >= 0)
);

-- La alerta de reposicion del panel se resuelve leyendo el principio de este
-- indice, sin recorrer el catalogo entero.
CREATE INDEX IX_STOCK_BAJO ON Stock(necesita_reposicion, tienda_id)
    INCLUDE (producto_id, cantidad, cantidad_minima);
GO

-- -----------------------------------------------------------------------------
-- 2.9 MOVIMIENTO_INVENTARIO -- LA DECISION CENTRAL DEL MODELO
--
-- No se guarda el stock: se guarda CADA HECHO QUE LO MODIFICO. El stock es la
-- suma de los movimientos.
--
-- POR QUE. Lo natural seria una columna que sube y baja. Funciona mientras haya
-- una sola fuente de escritura y conexion permanente, y no se cumple ninguna de
-- las dos: hay dos tiendas, cada una con su tablet, y la senial es
-- intermitente. El escenario que lo rompe:
--
--   1. La tablet pierde internet con 50 tornillos en stock.
--   2. Vende 3. Localmente anota "quedan 47".
--   3. Mientras tanto entran 100 tornillos por el panel: el servidor dice 150.
--   4. Vuelve la conexion y la tablet sincroniza "el stock es 47".
--   5. Los 100 tornillos que entraron desaparecieron.
--
-- Enviar un estado final pisa lo que hicieron los demas. Enviando el DELTA
-- (-3 y +100) el resultado es 147 llegue en el orden que llegue, porque la
-- suma es conmutativa. De ahi sale la propiedad que hace viable trabajar sin
-- conexion, y de regalo quedan la auditoria completa y la reconstruccion
-- historica ("cuanto habia el 15 de agosto").
--
-- EL SIGNO. Positivo si entra mercaderia, negativo si sale. Lo impone la
-- restriccion CK_MOVIMIENTO_SIGNO, no la buena voluntad de la aplicacion: sin
-- ella una venta podria AUMENTAR el stock, y el error es invisible.
-- -----------------------------------------------------------------------------
CREATE TABLE MOVIMIENTO_INVENTARIO (
    id             INT              IDENTITY(1,1) PRIMARY KEY,

    -- CLAVE DE IDEMPOTENCIA, generada en el DISPOSITIVO.
    --
    -- La tablet no sabe si su envio anterior llego: la respuesta pudo perderse
    -- en el camino, asi que reintenta. Si el servidor reprocesara el reenvio,
    -- el stock se descontaria dos veces.
    --
    -- La clave primaria no sirve para esto: es IDENTITY, la asigna el servidor,
    -- y un reenvio obtendria un id nuevo. Por eso el dispositivo genera ademas
    -- un GUID propio y lo manda; el indice unico hace que el segundo envio
    -- choque y se descarte. Reenviar cien veces el mismo movimiento produce el
    -- mismo resultado que enviarlo una vez.
    uuid_externo   UNIQUEIDENTIFIER NULL,

    tienda_id      INT              NOT NULL,
    producto_id    INT              NOT NULL,
    -- Quien lo hizo. NULL si el usuario fue dado de baja: se pierde el nombre,
    -- no el movimiento.
    usuario_id     INT NULL,
    -- Si el movimiento salio de una venta, cual. Permite ir de la factura al
    -- descuento de stock y al reves, sin leer el texto del motivo.
    venta_id       INT NULL,

    tipo           VARCHAR(20)      NOT NULL,
    cantidad       DECIMAL(18,3)    NOT NULL,
    -- Costo al momento del movimiento, congelado: permite valorizar el
    -- inventario historicamente aunque el proveedor cambie sus precios.
    costo_unitario DECIMAL(18,2),
    motivo         VARCHAR(255),

    -- Cuando OCURRIO en la tienda (lo pone el dispositivo) y cuando LLEGO al
    -- servidor. Comparar ambas mide el retraso de sincronizacion.
    ocurrido_en    DATETIME2(3)     NOT NULL DEFAULT SYSUTCDATETIME(),
    created_at     DATETIME2(3)     NOT NULL DEFAULT SYSUTCDATETIME(),

    CONSTRAINT FK_MOV_TIENDA   FOREIGN KEY (tienda_id)   REFERENCES TIENDA(id),
    CONSTRAINT FK_MOV_PRODUCTO FOREIGN KEY (producto_id) REFERENCES PRODUCTO(id),
    CONSTRAINT FK_MOV_USUARIO  FOREIGN KEY (usuario_id)  REFERENCES Usuario(id),

    CONSTRAINT CK_MOVIMIENTO_TIPO CHECK
        (tipo IN ('entrada', 'venta', 'devolucion', 'merma', 'ajuste')),

    -- Un movimiento de cantidad cero no significa nada.
    CONSTRAINT CK_MOVIMIENTO_NO_CERO CHECK (cantidad <> 0),

    CONSTRAINT CK_MOVIMIENTO_SIGNO CHECK (
        (tipo IN ('entrada', 'devolucion') AND cantidad > 0) OR
        (tipo IN ('venta',   'merma')      AND cantidad < 0) OR
        (tipo = 'ajuste')   -- el ajuste corrige en cualquier direccion
    )
);

CREATE UNIQUE INDEX UX_MOV_UUID ON MOVIMIENTO_INVENTARIO(uuid_externo)
    WHERE uuid_externo IS NOT NULL;
CREATE INDEX IX_MOV_TIENDA_PRODUCTO ON MOVIMIENTO_INVENTARIO(tienda_id, producto_id);
CREATE INDEX IX_MOV_FECHA           ON MOVIMIENTO_INVENTARIO(tienda_id, ocurrido_en DESC);
CREATE INDEX IX_MOV_VENTA           ON MOVIMIENTO_INVENTARIO(venta_id) WHERE venta_id IS NOT NULL;
GO

-- -----------------------------------------------------------------------------
-- 2.10 DISPOSITIVO y SYNC_LOG
--
-- Cada tablet y cuando sincronizo por ultima vez. Sirve para que el panel
-- avise "la tablet de la plastiqueria no sincroniza hace 3 horas", que suele
-- ser el primer sintoma de un problema.
-- -----------------------------------------------------------------------------
CREATE TABLE DISPOSITIVO (
    id          INT          IDENTITY(1,1) PRIMARY KEY,
    tienda_id   INT          NOT NULL,
    nombre      VARCHAR(100) NOT NULL,
    ultimo_sync DATETIME2(3),
    activo      BIT          NOT NULL DEFAULT 1,
    created_at  DATETIME2(3) NOT NULL DEFAULT SYSUTCDATETIME(),

    CONSTRAINT FK_DISPOSITIVO_TIENDA FOREIGN KEY (tienda_id) REFERENCES TIENDA(id)
);

CREATE TABLE SYNC_LOG (
    id                   INT          IDENTITY(1,1) PRIMARY KEY,
    dispositivo_id       INT          NOT NULL,
    registros_enviados   INT          NOT NULL DEFAULT 0,
    registros_aceptados  INT          NOT NULL DEFAULT 0,
    -- Descartados por idempotencia: no son un error, son la prueba de que el
    -- reintento funciono como debia.
    registros_duplicados INT          NOT NULL DEFAULT 0,
    error                VARCHAR(MAX),
    created_at           DATETIME2(3) NOT NULL DEFAULT SYSUTCDATETIME(),

    CONSTRAINT FK_SYNCLOG_DISPOSITIVO FOREIGN KEY (dispositivo_id) REFERENCES DISPOSITIVO(id)
);

CREATE INDEX IX_SYNCLOG_DISPOSITIVO ON SYNC_LOG(dispositivo_id, created_at DESC);
GO

-- -----------------------------------------------------------------------------
-- 2.11 CAJA -- el turno de trabajo
--
-- SOBRE 'diferencia' Y EL EFECTIVO ESPERADO.
-- El efectivo esperado (monto inicial + ventas en efectivo del turno) NO se
-- guarda: es exactamente lo que 'diferencia' ya expresa, y almacenar los dos
-- seria guardar el mismo dato dos veces, con el riesgo de que se contradigan.
--
-- Lo esperado se RECALCULA cuando hace falta, en la vista v_cuadre_caja, que
-- suma las ventas en efectivo de la caja y compara contra lo contado. Esa
-- vista es la que permite detectar si el valor guardado en 'diferencia' dejo
-- de coincidir con la realidad -- que es justamente lo que una columna
-- redundante no permitiria ver.
-- -----------------------------------------------------------------------------
CREATE TABLE CAJA (
    id                  INT           IDENTITY(1,1) PRIMARY KEY,
    tienda_id           INT           NOT NULL,
    usuario_id          INT           NOT NULL,

    monto_inicial       DECIMAL(18,2) NOT NULL DEFAULT 0.00,
    -- Lo que hay fisicamente en el cajon al cerrar. NULL mientras esta abierta:
    -- todavia no se conto.
    efectivo_contado    DECIMAL(18,2) NULL,
    -- Faltante (negativo) o sobrante (positivo) del arqueo.
    diferencia          DECIMAL(18,2) NULL,

    estado              VARCHAR(20)   NOT NULL DEFAULT 'abierta',
    abierta_en          DATETIME2(3)  NOT NULL DEFAULT SYSUTCDATETIME(),
    cerrada_en          DATETIME2(3)  NULL,
    observaciones       VARCHAR(MAX),

    CONSTRAINT FK_CAJA_TIENDA  FOREIGN KEY (tienda_id)  REFERENCES TIENDA(id),
    CONSTRAINT FK_CAJA_USUARIO FOREIGN KEY (usuario_id) REFERENCES Usuario(id),
    CONSTRAINT CK_CAJA_ESTADO CHECK (estado IN ('abierta', 'cerrada', 'revisada')),

    -- Una caja cerrada tiene que tener fecha de cierre y plata contada. Sin
    -- esto se puede marcar una caja como cerrada sin haberla arqueado, que es
    -- precisamente el control que esta tabla existe para imponer.
    CONSTRAINT CK_CAJA_CIERRE_COMPLETO CHECK (
        estado = 'abierta'
        OR (cerrada_en IS NOT NULL AND efectivo_contado IS NOT NULL)
    )
);

-- Indice unico FILTRADO: una sola caja ABIERTA por tienda a la vez. Es la
-- version SQL Server del indice unico parcial. Sin el, dos turnos solapados
-- cobran contra la misma caja y el arqueo no cuadra nunca.
CREATE UNIQUE INDEX UX_CAJA_ABIERTA_POR_TIENDA ON CAJA(tienda_id)
    WHERE estado = 'abierta';
GO

-- -----------------------------------------------------------------------------
-- 2.12 VENTA
-- -----------------------------------------------------------------------------
CREATE TABLE VENTA (
    id            INT              IDENTITY(1,1) PRIMARY KEY,
    -- Misma idea que en los movimientos: lo genera la tablet y hace que
    -- reenviar la venta no la duplique.
    uuid_externo  UNIQUEIDENTIFIER NULL,

    tienda_id     INT              NOT NULL,
    usuario_id    INT NULL,
    caja_id       INT NULL,
    -- A quien se le fio. NULL en la venta de mostrador comun, que es la
    -- mayoria: solo el credito necesita saber de quien es la deuda.
    cliente_id    INT NULL,

    -- Correlativo POR TIENDA, no global: las dos numeran en paralelo aunque
    -- esten desconectadas entre si. El comprobante legible se arma con el
    -- prefijo de la tienda ('FER-1001').
    numero        INT              NOT NULL,

    subtotal      DECIMAL(18,2)    NOT NULL DEFAULT 0.00,
    descuento     DECIMAL(18,2)    NOT NULL DEFAULT 0.00,
    total         DECIMAL(18,2)    NOT NULL DEFAULT 0.00,
    metodo_pago   VARCHAR(20)      NOT NULL DEFAULT 'efectivo',
    anulada       BIT              NOT NULL DEFAULT 0,
    observaciones VARCHAR(MAX),

    ocurrido_en   DATETIME2(3)     NOT NULL DEFAULT SYSUTCDATETIME(),
    created_at    DATETIME2(3)     NOT NULL DEFAULT SYSUTCDATETIME(),

    CONSTRAINT FK_VENTA_TIENDA  FOREIGN KEY (tienda_id)  REFERENCES TIENDA(id),
    CONSTRAINT FK_VENTA_USUARIO FOREIGN KEY (usuario_id) REFERENCES Usuario(id),
    CONSTRAINT FK_VENTA_CAJA    FOREIGN KEY (caja_id)    REFERENCES CAJA(id),
    CONSTRAINT FK_VENTA_CLIENTE FOREIGN KEY (cliente_id) REFERENCES CLIENTE(id),

    CONSTRAINT CK_VENTA_METODO CHECK
        (metodo_pago IN ('efectivo', 'tarjeta', 'transferencia', 'credito', 'otro')),

    -- No se puede fiar al aire. Sin esto vuelve el problema que CLIENTE vino a
    -- resolver: deuda registrada sin deudor.
    CONSTRAINT CK_VENTA_CLIENTE_CREDITO CHECK
        (metodo_pago <> 'credito' OR cliente_id IS NOT NULL),
    CONSTRAINT CK_VENTA_MONTOS CHECK (subtotal >= 0 AND descuento >= 0 AND total >= 0),
    -- El total no puede contradecir a sus partes. Es la clase de error que
    -- nadie detecta mirando, porque el numero parece razonable.
    CONSTRAINT CK_VENTA_TOTAL CHECK (total = subtotal - descuento),

    -- Dos facturas no pueden compartir numero dentro de la misma tienda.
    CONSTRAINT UQ_VENTA_NUMERO UNIQUE (tienda_id, numero)
);

CREATE UNIQUE INDEX UX_VENTA_UUID ON VENTA(uuid_externo) WHERE uuid_externo IS NOT NULL;
CREATE INDEX IX_VENTA_FECHA ON VENTA(tienda_id, ocurrido_en DESC);
CREATE INDEX IX_VENTA_CAJA  ON VENTA(caja_id) WHERE caja_id IS NOT NULL;
-- El saldo de un cliente se calcula sumando sus ventas a credito: sin este
-- indice, cada venta fiada recorreria la tabla entera para validar el limite.
CREATE INDEX IX_VENTA_CLIENTE ON VENTA(cliente_id) WHERE cliente_id IS NOT NULL;
GO

-- Ahora que existe VENTA se puede cerrar el vinculo desde los movimientos.
-- La clave foranea no se declaro antes porque la tabla todavia no existia.
ALTER TABLE MOVIMIENTO_INVENTARIO
    ADD CONSTRAINT FK_MOV_VENTA FOREIGN KEY (venta_id) REFERENCES VENTA(id);
GO

-- -----------------------------------------------------------------------------
-- 2.13 VENTA_LINEA -- entidad debil
--
-- Su clave primaria es (venta_id, numero): una linea no existe por si sola,
-- solo dentro de su venta, y se identifica por el orden en que aparece en el
-- comprobante. Es la definicion de entidad debil, y el ON DELETE CASCADE la
-- completa: borrar la venta se lleva sus lineas.
--
-- PRECIOS CONGELADOS. Guarda copia del precio y del costo al momento de
-- vender. Es duplicacion a proposito: sin ella, subir el precio de un balde de
-- 38 a 45 haria que todos los reportes de ganancia del anio pasado se
-- recalcularan solos, mostrando utilidades que nunca ocurrieron.
-- Guardar tambien el COSTO es lo que permite calcular el margen real.
-- -----------------------------------------------------------------------------
CREATE TABLE VENTA_LINEA (
    venta_id        INT           NOT NULL,
    numero          INT           NOT NULL,
    producto_id     INT           NOT NULL,
    cantidad        DECIMAL(18,3) NOT NULL,
    precio_unitario DECIMAL(18,2) NOT NULL,
    costo_unitario  DECIMAL(18,2) NOT NULL DEFAULT 0.00,
    -- LA REBAJA POR MAYOREO VIVE ACA, NO EN LA CABECERA.
    --
    -- El negocio no tiene precios de mayoreo cargados: la rebaja la negocia el
    -- empleado en el mostrador. Este campo es el unico lugar donde eso queda
    -- registrado, asi que el "descuento" del modelo ES el mayoreo.
    --
    -- Va por linea y no por venta porque la rebaja es sobre un PRODUCTO ("te
    -- dejo mas baratos los tubos"), no sobre la boleta. Con un monto suelto en
    -- la cabecera habria que prorratearlo entre las lineas para saber cuanto
    -- se gano con cada producto, y cualquier forma de prorratearlo es inventada.
    descuento       DECIMAL(18,2) NOT NULL DEFAULT 0.00,
    subtotal        DECIMAL(18,2) NOT NULL,

    CONSTRAINT PK_VENTA_LINEA PRIMARY KEY (venta_id, numero),
    CONSTRAINT FK_VENTALINEA_VENTA    FOREIGN KEY (venta_id)    REFERENCES VENTA(id) ON DELETE CASCADE,
    CONSTRAINT FK_VENTALINEA_PRODUCTO FOREIGN KEY (producto_id) REFERENCES PRODUCTO(id),

    CONSTRAINT CK_LINEA_CANTIDAD CHECK (cantidad > 0),
    -- No se puede regalar mas de lo que vale el renglon: si no, el subtotal
    -- sale negativo y la venta termina sumando en contra.
    CONSTRAINT CK_LINEA_DESCUENTO CHECK
        (descuento >= 0 AND descuento <= ROUND(cantidad * precio_unitario, 2)),
    CONSTRAINT CK_LINEA_SUBTOTAL CHECK
        (subtotal = ROUND(cantidad * precio_unitario, 2) - descuento),

    -- Un producto, una linea. Si el mismo articulo entra dos veces, el
    -- descuento queda partido y el reporte por producto miente.
    CONSTRAINT UQ_LINEA_PRODUCTO UNIQUE (venta_id, producto_id)
);

CREATE INDEX IX_LINEA_PRODUCTO ON VENTA_LINEA(producto_id);
GO

-- -----------------------------------------------------------------------------
-- 2.14 PAGO_CREDITO -- los abonos
--
-- El abono va contra la CUENTA DEL CLIENTE, no contra una factura. Con pagos
-- parciales, atarlos a una venta obligaria al empleado a elegir que boletas
-- cancela cuando el cliente le pone quinientos pesos en el mostrador. Nadie
-- hace eso: se abona a la cuenta y listo.
--
-- POR QUE LLEVA caja_id -- Y ES EL DETALLE QUE ROMPE EL ARQUEO SI FALTA.
-- Un abono en efectivo es plata que entra al cajon SIN que haya una venta. El
-- cuadre calcula el efectivo esperado a partir de las ventas del turno, asi
-- que si alguien pasa a abonar una deuda vieja, al cerrar aparecen de mas y la
-- caja marca un sobrante que no existe. Por eso el abono sabe en que caja cayo
-- y v_cuadre_caja lo suma.
-- -----------------------------------------------------------------------------
CREATE TABLE PAGO_CREDITO (
    id            INT           IDENTITY(1,1) PRIMARY KEY,
    cliente_id    INT           NOT NULL,
    -- NULL si el abono no entro por una caja abierta (transferencia recibida
    -- fuera del turno, por ejemplo).
    caja_id       INT NULL,
    -- Quien lo recibio. NULL si ese usuario fue dado de baja: se pierde el
    -- nombre, no el abono.
    usuario_id    INT NULL,
    monto         DECIMAL(18,2) NOT NULL,
    metodo_pago   VARCHAR(20)   NOT NULL DEFAULT 'efectivo',
    observaciones VARCHAR(MAX),
    ocurrido_en   DATETIME2(3)  NOT NULL DEFAULT SYSUTCDATETIME(),
    created_at    DATETIME2(3)  NOT NULL DEFAULT SYSUTCDATETIME(),

    CONSTRAINT FK_PAGO_CLIENTE FOREIGN KEY (cliente_id) REFERENCES CLIENTE(id),
    CONSTRAINT FK_PAGO_CAJA    FOREIGN KEY (caja_id)    REFERENCES CAJA(id),
    CONSTRAINT FK_PAGO_USUARIO FOREIGN KEY (usuario_id) REFERENCES Usuario(id),

    -- Un abono de cero no significa nada, y uno negativo seria una venta
    -- disfrazada: para aumentar la deuda esta la venta a credito.
    CONSTRAINT CK_PAGO_MONTO  CHECK (monto > 0),
    -- Sin 'credito': no se puede pagar una deuda con otra deuda.
    CONSTRAINT CK_PAGO_METODO CHECK
        (metodo_pago IN ('efectivo', 'tarjeta', 'transferencia', 'otro'))
);

-- El saldo del cliente suma sus abonos: mismo motivo que IX_VENTA_CLIENTE.
CREATE INDEX IX_PAGO_CLIENTE ON PAGO_CREDITO(cliente_id, ocurrido_en DESC);
CREATE INDEX IX_PAGO_CAJA    ON PAGO_CREDITO(caja_id) WHERE caja_id IS NOT NULL;
GO

-- -----------------------------------------------------------------------------
-- 2.15 SESION
--
-- Una fila por sesion abierta. El usuario recibe un token al entrar y lo manda
-- en cada peticion.
--
-- POR QUE UNA TABLA Y NO UN TOKEN AUTOCONTENIDO (tipo JWT): un token firmado
-- no se puede revocar. Si una tablet se pierde o alguien deja de trabajar, el
-- token sigue valido hasta caducar. Con una tabla, revocar es un UPDATE.
--
-- POR QUE SE GUARDA EL HASH DEL TOKEN: mismo motivo que con las contrasenias.
-- Si se filtra un volcado de la base, con los tokens en claro se entra como
-- cualquier usuario con sesion abierta. Aca alcanza SHA-256 (y no scrypt, como
-- en las claves) porque el token son 32 bytes al azar: no hay diccionario que
-- probar, asi que no hace falta encarecer cada intento.
-- -----------------------------------------------------------------------------
CREATE TABLE SESION (
    token_hash     CHAR(64)     NOT NULL PRIMARY KEY,   -- SHA-256 en hexadecimal
    usuario_id     INT          NOT NULL,
    dispositivo_id INT NULL,
    -- DESDE QUE TIENDA esta operando esta sesion.
    --
    -- Antes se deducia de Usuario.tienda_id. Con empleados que trabajan en las
    -- dos ya no se puede deducir: la persona la ELIGE al entrar y queda fija
    -- mientras dure la sesion. Para el alcance de los datos importa desde
    -- donde esta vendiendo ahora, no a donde pertenece.
    --
    -- NULL = administrador, que no opera desde un local y ve los dos.
    tienda_id      INT NULL,
    expira_en      DATETIME2(3) NOT NULL,
    revocada_en    DATETIME2(3) NULL,                   -- NULL = sigue viva
    created_at     DATETIME2(3) NOT NULL DEFAULT SYSUTCDATETIME(),

    CONSTRAINT FK_SESION_USUARIO     FOREIGN KEY (usuario_id)     REFERENCES Usuario(id),
    CONSTRAINT FK_SESION_DISPOSITIVO FOREIGN KEY (dispositivo_id) REFERENCES DISPOSITIVO(id),
    CONSTRAINT FK_SESION_TIENDA      FOREIGN KEY (tienda_id)      REFERENCES TIENDA(id),
    CONSTRAINT CK_SESION_VIGENCIA CHECK (expira_en > created_at)
);

-- Indice filtrado: las sesiones muertas se acumulan para siempre (son la
-- bitacora de accesos) pero no engordan el indice que se consulta en cada
-- peticion.
CREATE INDEX IX_SESION_USUARIO ON SESION(usuario_id) WHERE revocada_en IS NULL;
GO

-- -----------------------------------------------------------------------------
-- 2.16 INTENTO_LOGIN
--
-- Un PIN de 4 digitos son 10.000 combinaciones. Un programa que pruebe una por
-- segundo las agota en menos de tres horas. EL HASH NO PROTEGE DE ESTO: protege
-- de que roben la base, no de que prueben por la puerta. Lo unico que lo frena
-- es contar los fallos y bloquear.
--
-- Se registran tambien los aciertos: el patron "veinte fallos y un acierto" es
-- la firma de un ataque que funciono, y sin los aciertos no se ve.
--
-- No hay clave foranea a Usuario a proposito: hay que poder registrar el
-- intento de entrar con un email que no existe, que es el caso interesante.
-- -----------------------------------------------------------------------------
CREATE TABLE INTENTO_LOGIN (
    id            INT          IDENTITY(1,1) PRIMARY KEY,
    identificador VARCHAR(150) NOT NULL,   -- email del admin, o id del empleado
    tienda_id     INT NULL,
    exitoso       BIT          NOT NULL,
    ip            VARCHAR(45),             -- 45 caracteres = IPv6 en forma larga
    created_at    DATETIME2(3) NOT NULL DEFAULT SYSUTCDATETIME(),

    CONSTRAINT FK_INTENTO_TIENDA FOREIGN KEY (tienda_id) REFERENCES TIENDA(id)
);

-- Indice filtrado sobre los fallos: la consulta de bloqueo pregunta siempre
-- "cuantos intentos FALLIDOS tuvo este identificador en los ultimos minutos".
CREATE INDEX IX_INTENTO_FALLIDO ON INTENTO_LOGIN(identificador, created_at DESC)
    WHERE exitoso = 0;
GO

-- =============================================================================
-- 3. TRIGGERS DE NEGOCIO
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 3.1 Mantener Stock al dia
--
-- CUIDADO -- EN SQL SERVER LOS TRIGGERS SE DISPARAN UNA VEZ POR SENTENCIA,
-- NO UNA VEZ POR FILA. 'inserted' es una tabla con TODAS las filas insertadas.
-- Escribir este trigger como si trajera una sola (SELECT cantidad FROM inserted)
-- funciona en las pruebas de a una fila y pierde datos silenciosamente en
-- cuanto llega un lote de sincronizacion. Por eso todo aca es por conjuntos.
--
-- Primero se AGRUPA: un mismo lote puede traer varios movimientos del mismo
-- producto, y hay que sumarlos antes de aplicarlos.
-- -----------------------------------------------------------------------------
CREATE OR ALTER TRIGGER trg_movimiento_actualiza_stock
ON MOVIMIENTO_INVENTARIO
AFTER INSERT
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @cambios TABLE (
        tienda_id   INT,
        producto_id INT,
        delta       DECIMAL(18,3),
        PRIMARY KEY (tienda_id, producto_id)
    );

    INSERT INTO @cambios (tienda_id, producto_id, delta)
    SELECT tienda_id, producto_id, SUM(cantidad)
      FROM inserted
     GROUP BY tienda_id, producto_id;

    -- Los que ya tienen fila: se les suma el delta.
    UPDATE s
       SET s.cantidad   = s.cantidad + c.delta,
           s.updated_at = SYSUTCDATETIME()
      FROM Stock s
      JOIN @cambios c
        ON c.tienda_id = s.tienda_id AND c.producto_id = s.producto_id;

    -- Los que no: se crea la fila con el delta como saldo inicial.
    INSERT INTO Stock (tienda_id, producto_id, cantidad, cantidad_minima, updated_at)
    SELECT c.tienda_id, c.producto_id, c.delta, 0, SYSUTCDATETIME()
      FROM @cambios c
     WHERE NOT EXISTS (
           SELECT 1 FROM Stock s
            WHERE s.tienda_id = c.tienda_id AND s.producto_id = c.producto_id);
END;
GO

-- -----------------------------------------------------------------------------
-- 3.2 El historial es inmutable
--
-- Impide fisicamente modificar o borrar un movimiento ya registrado. Ni la
-- aplicacion ni alguien conectado con SSMS pueden alterar el historial: la
-- unica forma de corregir es insertar un movimiento de 'ajuste' que compense.
-- Asi el historial nunca miente, y el error y su correccion quedan ambos a la
-- vista.
--
-- Es un trigger INSTEAD OF y no un AFTER: el AFTER tendria que dejar que la
-- modificacion ocurra para despues revertirla. El INSTEAD OF la reemplaza por
-- el error, sin tocar los datos.
--
-- (El modelo anterior resolvia esto con una columna 'append_only BIT'. Una
-- columna no impide nada: es un dato, no una regla. Cualquier UPDATE la ignora.)
-- -----------------------------------------------------------------------------
CREATE OR ALTER TRIGGER trg_movimientos_inmutables
ON MOVIMIENTO_INVENTARIO
INSTEAD OF UPDATE, DELETE
AS
BEGIN
    SET NOCOUNT ON;
    THROW 50001,
        'MOVIMIENTO_INVENTARIO es de solo agregado: para corregir, registre un movimiento de tipo ajuste.',
        1;
END;
GO

-- -----------------------------------------------------------------------------
-- 3.3 El limite de credito se respeta
--
-- POR QUE UN TRIGGER Y NO UN CHECK: el limite compara contra la suma de las
-- OTRAS ventas del cliente y de sus abonos. Un CHECK solo ve la fila que se
-- esta insertando, asi que no puede expresarlo.
--
-- POR QUE EN LA BASE Y NO EN LA API: es la misma razon que CK_USUARIO_
-- CREDENCIALES. Una regla que vive solo en el endpoint la saltea cualquier
-- script que inserte directo, y el dia que pase nadie se entera.
--
-- ESTO SOLO FUNCIONA PORQUE EL CREDITO ES SOLO ONLINE. Si se pudiera fiar sin
-- senial, dos tiendas desconectadas podrian pasarse del limite cada una por su
-- lado y el choque recien aparecer al sincronizar, cuando ya no hay nada que
-- hacer. Por eso /sync rechaza las ventas a credito que llegan por lote.
--
-- Valida SOLO lo que se esta tocando: si manana le bajan el cupo a alguien que
-- ya debe de mas, la deuda existente no se invalida -- seria absurdo --
-- simplemente no puede fiar mas.
--
-- VA TAMBIEN EN UPDATE, no solo en INSERT. Con AFTER INSERT a secas queda un
-- agujero: insertar la venta en cero y subirle el total despues esquiva el
-- limite por completo, y es exactamente lo que hace cualquier flujo que arme
-- la cabecera a partir de las lineas.
--
-- Por conjuntos, como todos los triggers de este archivo.
-- -----------------------------------------------------------------------------
CREATE OR ALTER TRIGGER trg_venta_credito_limite
ON VENTA
AFTER INSERT, UPDATE
AS
BEGIN
    SET NOCOUNT ON;

    IF NOT EXISTS (SELECT 1 FROM inserted WHERE metodo_pago = 'credito')
        RETURN;

    -- Clientes tocados por este lote. DISTINCT porque una misma persona puede
    -- aparecer en varias ventas del mismo envio.
    DECLARE @clientes TABLE (cliente_id INT PRIMARY KEY);

    INSERT INTO @clientes (cliente_id)
    SELECT DISTINCT cliente_id
      FROM inserted
     WHERE metodo_pago = 'credito'
       AND cliente_id IS NOT NULL;

    -- El saldo se calcula entero, no por diferencia: incluye las ventas recien
    -- insertadas porque el trigger es AFTER.
    IF EXISTS (
        SELECT 1
          FROM @clientes q
          JOIN CLIENTE cl ON cl.id = q.cliente_id
         CROSS APPLY (
            SELECT
                ISNULL((SELECT SUM(v.total)
                          FROM VENTA v
                         WHERE v.cliente_id   = cl.id
                           AND v.metodo_pago  = 'credito'
                           AND v.anulada      = 0), 0)
              - ISNULL((SELECT SUM(p.monto)
                          FROM PAGO_CREDITO p
                         WHERE p.cliente_id = cl.id), 0) AS saldo
         ) s
         WHERE s.saldo > cl.limite_credito
    )
        THROW 50002,
            'La venta a credito supera el limite del cliente.',
            1;
END;
GO

-- =============================================================================
-- 4. VISTAS -- los reportes del panel
--
-- El calculo vive en la BASE y no en la aplicacion, para que el mismo numero
-- salga igual desde la API, desde SSMS o desde cualquier herramienta de
-- reportes que se conecte despues.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 4.1 Inventario valorizado: cuanta plata hay parada en mercaderia
-- -----------------------------------------------------------------------------
CREATE OR ALTER VIEW v_inventario_valorizado AS
SELECT
    t.id     AS tienda_id,
    t.nombre AS tienda,
    p.id     AS producto_id,
    p.codigo,
    p.nombre AS producto,
    s.cantidad,
    s.cantidad_minima,
    p.precio_costo,
    p.precio_venta,
    CAST(ROUND(s.cantidad * p.precio_costo, 2) AS DECIMAL(18,2)) AS valor_costo,
    CAST(ROUND(s.cantidad * p.precio_venta, 2) AS DECIMAL(18,2)) AS valor_venta,
    CAST(s.necesita_reposicion AS BIT) AS necesita_reposicion
FROM Stock s
JOIN TIENDA   t ON t.id = s.tienda_id
JOIN PRODUCTO p ON p.id = s.producto_id
WHERE p.activo = 1;
GO

-- -----------------------------------------------------------------------------
-- 4.2 Ventas por dia y por tienda, con ganancia real
--
-- Responde la pregunta que hoy nadie puede contestar sin sentarse dos horas:
-- no cuanto se VENDIO, sino cuanto se GANO.
--
-- CUIDADO -- ERROR DE AGREGACION POR FAN-OUT:
-- La tentacion es unir VENTA con VENTA_LINEA y sumar todo junto. Esta mal. El
-- JOIN multiplica la cabecera por cada linea: una venta de 880 con dos
-- articulos aparece DOS veces y SUM(total) devuelve 1760. La ganancia sale
-- inflada y nadie lo nota, porque el numero parece razonable.
--
-- La solucion es agregar las lineas PRIMERO (una fila por venta) y recien
-- despues unirlas a la cabecera.
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
    CAST(v.ocurrido_en AS DATE) AS fecha,
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
GROUP BY v.tienda_id, t.nombre, CAST(v.ocurrido_en AS DATE);
GO

-- -----------------------------------------------------------------------------
-- 4.3 Productos que necesitan reposicion
-- -----------------------------------------------------------------------------
CREATE OR ALTER VIEW v_alertas_stock AS
SELECT TOP 100 PERCENT
    t.id     AS tienda_id,
    t.nombre AS tienda,
    p.codigo,
    p.nombre AS producto,
    s.cantidad,
    s.cantidad_minima,
    p.unidad_medida
FROM Stock s
JOIN TIENDA   t ON t.id = s.tienda_id
JOIN PRODUCTO p ON p.id = s.producto_id
WHERE p.activo = 1
  AND s.necesita_reposicion = 1;
GO

-- -----------------------------------------------------------------------------
-- 4.4 Cuadre de caja
--
-- Aca es donde se paga el no haber guardado el efectivo esperado: se recalcula.
--
-- esperado = monto_inicial + ventas en efectivo + abonos en efectivo
-- diferencia_real = efectivo_contado - esperado
--
-- LOS ABONOS CUENTAN. Un cliente que pasa a pagar una deuda vieja deja plata
-- en el cajon sin que haya una venta: sin sumarlos, el arqueo marca un
-- sobrante que no existe y el empleado termina desconfiando del sistema.
--
-- La columna 'diferencia' que guarda CAJA es lo que la aplicacion anoto al
-- cerrar el turno. 'diferencia_real' es lo que sale de las ventas registradas.
-- Cuando no coinciden, 'cuadra' da 0 y hay algo que revisar: o se cargo mal el
-- arqueo, o entraron ventas despues de cerrar.
--
-- Ese contraste es imposible de hacer si el valor esperado se guarda como
-- columna, porque entonces ambos lados del calculo salen del mismo dato.
-- -----------------------------------------------------------------------------
CREATE OR ALTER VIEW v_cuadre_caja AS
WITH efectivo AS (
    SELECT v.caja_id, SUM(v.total) AS vendido_efectivo
      FROM VENTA v
     WHERE v.anulada = 0
       AND v.metodo_pago = 'efectivo'
       AND v.caja_id IS NOT NULL
     GROUP BY v.caja_id
),
abonos AS (
    SELECT p.caja_id, SUM(p.monto) AS abonado_efectivo
      FROM PAGO_CREDITO p
     WHERE p.metodo_pago = 'efectivo'
       AND p.caja_id IS NOT NULL
     GROUP BY p.caja_id
)
SELECT
    c.id         AS caja_id,
    c.tienda_id,
    t.nombre     AS tienda,
    u.nombre     AS usuario,
    c.estado,
    c.abierta_en,
    c.cerrada_en,
    c.monto_inicial,
    ISNULL(e.vendido_efectivo, 0)  AS vendido_efectivo,
    ISNULL(a.abonado_efectivo, 0)  AS abonado_efectivo,
    c.monto_inicial + ISNULL(e.vendido_efectivo, 0) + ISNULL(a.abonado_efectivo, 0) AS esperado,
    c.efectivo_contado,
    c.diferencia                   AS diferencia_registrada,
    c.efectivo_contado
      - (c.monto_inicial + ISNULL(e.vendido_efectivo, 0) + ISNULL(a.abonado_efectivo, 0)) AS diferencia_real,
    CAST(CASE
        WHEN c.efectivo_contado IS NULL THEN NULL
        WHEN c.diferencia = c.efectivo_contado
             - (c.monto_inicial + ISNULL(e.vendido_efectivo, 0) + ISNULL(a.abonado_efectivo, 0))
            THEN 1 ELSE 0
    END AS BIT) AS cuadra
FROM CAJA c
JOIN TIENDA  t ON t.id = c.tienda_id
JOIN Usuario u ON u.id = c.usuario_id
LEFT JOIN efectivo e ON e.caja_id = c.id
LEFT JOIN abonos   a ON a.caja_id = c.id;
GO

-- -----------------------------------------------------------------------------
-- 4.5 Cuentas por cobrar: quien debe y cuanto
--
-- La respuesta a la pregunta que el negocio hoy no puede contestar. Fiar lo
-- hacen desde siempre; saber cuanto les deben en total, no.
--
-- El saldo se DERIVA aca y no se guarda en CLIENTE. Asi, anular una venta
-- fiada baja la deuda sola, sin que nadie tenga que acordarse de restarla.
-- -----------------------------------------------------------------------------
CREATE OR ALTER VIEW v_cuentas_por_cobrar AS
WITH fiado AS (
    SELECT v.cliente_id,
           SUM(v.total)       AS total_fiado,
           COUNT(*)           AS ventas_a_credito,
           MAX(v.ocurrido_en) AS ultima_venta
      FROM VENTA v
     WHERE v.metodo_pago = 'credito'
       AND v.anulada     = 0
       AND v.cliente_id IS NOT NULL
     GROUP BY v.cliente_id
),
abonado AS (
    SELECT p.cliente_id,
           SUM(p.monto)       AS total_abonado,
           MAX(p.ocurrido_en) AS ultimo_abono
      FROM PAGO_CREDITO p
     GROUP BY p.cliente_id
)
SELECT
    c.id     AS cliente_id,
    c.nombre,
    c.telefono,
    c.limite_credito,
    ISNULL(f.total_fiado, 0)   AS total_fiado,
    ISNULL(a.total_abonado, 0) AS total_abonado,
    ISNULL(f.total_fiado, 0) - ISNULL(a.total_abonado, 0) AS saldo,
    c.limite_credito - (ISNULL(f.total_fiado, 0) - ISNULL(a.total_abonado, 0)) AS cupo_disponible,
    ISNULL(f.ventas_a_credito, 0) AS ventas_a_credito,
    f.ultima_venta,
    a.ultimo_abono
FROM CLIENTE c
LEFT JOIN fiado   f ON f.cliente_id = c.id
LEFT JOIN abonado a ON a.cliente_id = c.id
WHERE c.activo = 1;
GO

-- =============================================================================
-- 5. RECONCILIACION DEL CACHE DE STOCK
--
-- Stock es un dato derivado. Esta es la red de seguridad que hace aceptable la
-- duplicacion: compara el cache contra la verdad (la suma de movimientos),
-- corrige las diferencias e informa cuales corrigio.
--
-- Se ejecuta a mano cuando se sospecha una desalineacion:
--     EXEC sp_recalcular_stock;
--     EXEC sp_recalcular_stock @solo_informar = 1;   -- sin tocar nada
-- =============================================================================
CREATE OR ALTER PROCEDURE sp_recalcular_stock
    @solo_informar BIT = 0
AS
BEGIN
    SET NOCOUNT ON;

    -- La verdad: lo que dicen los movimientos.
    WITH verdad AS (
        SELECT tienda_id, producto_id, SUM(cantidad) AS cantidad_real
          FROM MOVIMIENTO_INVENTARIO
         GROUP BY tienda_id, producto_id
    )
    SELECT
        v.tienda_id,
        v.producto_id,
        p.nombre AS producto,
        ISNULL(s.cantidad, 0) AS cantidad_cache,
        v.cantidad_real,
        v.cantidad_real - ISNULL(s.cantidad, 0) AS desvio
    INTO #diferencias
    FROM verdad v
    JOIN PRODUCTO p ON p.id = v.producto_id
    LEFT JOIN Stock s
           ON s.tienda_id = v.tienda_id AND s.producto_id = v.producto_id
    WHERE ISNULL(s.cantidad, 0) <> v.cantidad_real;

    SELECT * FROM #diferencias ORDER BY ABS(desvio) DESC;

    -- PRINT no admite subconsultas, asi que el conteo se pasa por una variable.
    DECLARE @corregidas INT = (SELECT COUNT(*) FROM #diferencias);

    IF @solo_informar = 0
    BEGIN
        UPDATE s
           SET s.cantidad   = d.cantidad_real,
               s.updated_at = SYSUTCDATETIME()
          FROM Stock s
          JOIN #diferencias d
            ON d.tienda_id = s.tienda_id AND d.producto_id = s.producto_id;

        INSERT INTO Stock (tienda_id, producto_id, cantidad, cantidad_minima, updated_at)
        SELECT d.tienda_id, d.producto_id, d.cantidad_real, 0, SYSUTCDATETIME()
          FROM #diferencias d
         WHERE NOT EXISTS (
               SELECT 1 FROM Stock s
                WHERE s.tienda_id = d.tienda_id AND s.producto_id = d.producto_id);

        PRINT CONCAT('Filas de stock corregidas: ', @corregidas);
    END
    ELSE
        PRINT CONCAT('Filas de stock desalineadas: ', @corregidas, ' (no se modifico nada)');

    DROP TABLE #diferencias;
END;
GO

-- =============================================================================
-- FIN DEL ESQUEMA
-- =============================================================================
PRINT 'Esquema de Ferreplast creado correctamente.';
GO
