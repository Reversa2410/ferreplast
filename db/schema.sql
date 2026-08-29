-- =============================================================================
-- FERREPLAST -- Esquema de base de datos
-- Sistema de gestion para ferreteria y plastiqueria
--
-- Motor:    PostgreSQL 15+
-- Encoding: UTF8
--
-- Este archivo es idempotente: se puede ejecutar varias veces seguidas.
-- Para recrear todo desde cero:  psql -f schema.sql
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 0. LIMPIEZA (solo desarrollo -- NUNCA correr esto en produccion)
-- -----------------------------------------------------------------------------
DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public;


-- -----------------------------------------------------------------------------
-- 1. TIPOS ENUMERADOS
--
-- En PostgreSQL un ENUM es un TIPO propio que se declara aparte; no se escribe
-- en linea dentro del CREATE TABLE (eso es sintaxis de MySQL).
--
-- Ventaja:    la BD rechaza cualquier valor fuera de la lista. Imposible tener
--             un rol 'admni' por un error de tipeo.
-- Desventaja: agregar un valor nuevo exige ALTER TYPE ... ADD VALUE. Si se
--             espera que la lista cambie seguido, conviene una tabla de catalogo
--             con clave foranea en lugar de un ENUM.
-- -----------------------------------------------------------------------------

CREATE TYPE tipo_tienda AS ENUM ('ferreteria', 'plastiqueria', 'otro');

CREATE TYPE rol_usuario AS ENUM ('empleado', 'encargado', 'admin');

CREATE TYPE tipo_movimiento AS ENUM (
    'entrada',      -- compra a proveedor / reabastecimiento   (+)
    'venta',        -- salida por venta al cliente             (-)
    'devolucion',   -- el cliente devuelve mercaderia          (+)
    'merma',        -- roto, vencido, perdido                  (-)
    'ajuste'        -- correccion tras inventario fisico      (+/-)
);

CREATE TYPE metodo_pago AS ENUM (
    'efectivo', 'tarjeta', 'transferencia', 'credito', 'otro'
);

CREATE TYPE estado_caja AS ENUM ('abierta', 'cerrada', 'revisada');


-- -----------------------------------------------------------------------------
-- 2. FUNCION AUXILIAR: mantener updated_at al dia
--
-- Una columna updated_at con DEFAULT NOW() solo se llena al INSERT. Para que
-- tambien se actualice en cada UPDATE hace falta un trigger. Se define la
-- funcion una sola vez y se reutiliza en todas las tablas que la necesiten.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION fn_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;


-- =============================================================================
-- 3. TABLAS
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 3.1 NEGOCIOS
--
-- Nivel mas alto de la jerarquia: la familia duenia de las dos tiendas es UN
-- negocio. Hoy hay una sola fila.
--
-- Por que existe si hoy sobra: si maniana el sistema se le vende a otra familia,
-- basta con insertar otra fila; no hay que rehacer el modelo ni levantar una
-- base de datos por cliente. Agregar esta tabla ahora cuesta dos claves
-- foraneas; agregarla dentro de un anio cuesta migrar todas las tablas con
-- datos reales adentro.
-- -----------------------------------------------------------------------------
CREATE TABLE negocios (
    id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    nombre          VARCHAR(150) NOT NULL,
    propietario     VARCHAR(150),
    telefono        VARCHAR(30),
    moneda          CHAR(3)      NOT NULL DEFAULT 'BOB',   -- ISO 4217
    activo          BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_negocios_updated
    BEFORE UPDATE ON negocios
    FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();


-- -----------------------------------------------------------------------------
-- 3.2 TIENDAS
--
-- La ferreteria y la plastiqueria. Cada una es un punto de venta independiente
-- con su propio stock y su propia caja, pero comparten catalogo y duenio.
-- -----------------------------------------------------------------------------
CREATE TABLE tiendas (
    id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    negocio_id      UUID         NOT NULL REFERENCES negocios(id) ON DELETE RESTRICT,
    nombre          VARCHAR(150) NOT NULL,
    tipo            tipo_tienda  NOT NULL,
    direccion       VARCHAR(255),
    -- Prefijo para numerar comprobantes: 'FER', 'PLA'. Evita que las dos
    -- tiendas generen el mismo numero de venta estando desconectadas.
    prefijo         VARCHAR(5)   NOT NULL,
    activo          BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_tiendas_prefijo UNIQUE (negocio_id, prefijo)
);

CREATE INDEX idx_tiendas_negocio ON tiendas(negocio_id);

CREATE TRIGGER trg_tiendas_updated
    BEFORE UPDATE ON tiendas
    FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();


-- -----------------------------------------------------------------------------
-- 3.3 USUARIOS
--
-- Empleados de mostrador y administradores (la familia).
--
-- Dos formas de entrar:
--   * empleado -> PIN corto en la tablet (rapido, se teclea 50 veces al dia)
--   * admin    -> email + contrasenia en el panel web
--
-- IMPORTANTE: se guarda el HASH, nunca el PIN ni la contrasenia en claro.
-- Un PIN de 4 digitos solo tiene 10.000 combinaciones, asi que ademas del hash
-- la aplicacion debe limitar los intentos fallidos.
--
-- tienda_id NULL = el usuario no esta atado a una tienda (caso del admin, que
-- ve las dos).
-- -----------------------------------------------------------------------------
CREATE TABLE usuarios (
    id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    negocio_id      UUID         NOT NULL REFERENCES negocios(id) ON DELETE RESTRICT,
    tienda_id       UUID         REFERENCES tiendas(id) ON DELETE SET NULL,
    nombre          VARCHAR(150) NOT NULL,
    email           VARCHAR(150),
    password_hash   TEXT,        -- para admins (login web)
    pin_hash        TEXT,        -- para empleados (login en tablet)
    rol             rol_usuario  NOT NULL DEFAULT 'empleado',
    activo          BOOLEAN      NOT NULL DEFAULT TRUE,
    ultimo_acceso   TIMESTAMPTZ,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_usuarios_email UNIQUE (email),

    -- Un admin necesita email+contrasenia; un empleado necesita PIN y tienda.
    -- La regla de negocio vive en la BD, no solo en el codigo de la app.
    CONSTRAINT chk_credenciales CHECK (
        (rol = 'admin'    AND email IS NOT NULL AND password_hash IS NOT NULL)
     OR (rol <> 'admin'   AND pin_hash IS NOT NULL AND tienda_id IS NOT NULL)
    )
);

CREATE INDEX idx_usuarios_tienda ON usuarios(tienda_id) WHERE activo;

CREATE TRIGGER trg_usuarios_updated
    BEFORE UPDATE ON usuarios
    FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();


-- -----------------------------------------------------------------------------
-- 3.4 CATEGORIAS
--
-- Jerarquia simple mediante auto-referencia (padre_id): "Fontaneria" puede
-- contener "Tuberias PVC". Con padre_id NULL la categoria es de primer nivel.
-- -----------------------------------------------------------------------------
CREATE TABLE categorias (
    id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    negocio_id      UUID         NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
    padre_id        UUID         REFERENCES categorias(id) ON DELETE SET NULL,
    nombre          VARCHAR(100) NOT NULL,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_categorias_nombre UNIQUE (negocio_id, nombre)
);


-- -----------------------------------------------------------------------------
-- 3.5 PRODUCTOS
--
-- Catalogo unico del negocio. Un producto existe una sola vez aunque se venda
-- en las dos tiendas; lo que cambia por tienda es el STOCK, no el producto.
-- Asi, cambiar el nombre o el precio de un articulo se hace en un solo lugar.
--
-- Sobre los precios:
--   precio_costo -> lo que se le paga al proveedor
--   precio_venta -> lo que paga el cliente
-- Son los precios VIGENTES. El precio historico de cada venta se congela en
-- venta_lineas (ver 3.9), porque si no, al subir un precio se recalcularian
-- hacia atras todas las ganancias del anio pasado.
-- -----------------------------------------------------------------------------
CREATE TABLE productos (
    id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    negocio_id      UUID          NOT NULL REFERENCES negocios(id) ON DELETE CASCADE,
    categoria_id    UUID          REFERENCES categorias(id) ON DELETE SET NULL,
    codigo          VARCHAR(50)   NOT NULL,   -- codigo de barras o interno
    nombre          VARCHAR(255)  NOT NULL,
    descripcion     TEXT,
    unidad_medida   VARCHAR(20)   NOT NULL DEFAULT 'unidad',  -- unidad, kg, metro, litro
    precio_costo    NUMERIC(12,2) NOT NULL DEFAULT 0,
    precio_venta    NUMERIC(12,2) NOT NULL,
    activo          BOOLEAN       NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_productos_codigo   UNIQUE (negocio_id, codigo),
    CONSTRAINT chk_precios_positivos CHECK (precio_costo >= 0 AND precio_venta >= 0)
);

CREATE INDEX idx_productos_categoria ON productos(categoria_id);
-- Busqueda por nombre en el mostrador: el empleado teclea "torn" y aparece
-- "Tornillo...". pg_trgm permite indexar busquedas por LIKE '%texto%'.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX idx_productos_nombre_trgm ON productos USING GIN (nombre gin_trgm_ops);

CREATE TRIGGER trg_productos_updated
    BEFORE UPDATE ON productos
    FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();


-- -----------------------------------------------------------------------------
-- 3.6 MOVIMIENTOS DE INVENTARIO   <-- NUCLEO DEL MODELO
--
-- Esta tabla es la FUENTE DE VERDAD del inventario. Es un registro de solo
-- insercion (append-only): nunca se hace UPDATE ni DELETE sobre una fila. Si
-- alguien se equivoco al cargar, se inserta un movimiento de 'ajuste' que
-- compensa. El historial queda intacto y auditable.
--
-- El stock nunca se "escribe"; se DEDUCE sumando las cantidades:
--     stock = SUM(cantidad) para esa tienda y ese producto
--
-- POR QUE ASI, y no una columna stock que se suma y se resta:
--
--   1. Sincronizacion sin conflictos. Las tablets trabajan sin internet. Si
--      cada una guardara "el stock quedo en 47", al sincronizar la ultima en
--      llegar pisaria a la otra y se perderia mercaderia. Sumando movimientos
--      independientes no hay nada que pisar: -3 y -5 dan -8 sin importar en
--      que orden lleguen.
--
--   2. Auditoria completa. Ante una diferencia en el conteo fisico se puede
--      reconstruir dia por dia que paso, quien lo hizo y cuando.
--
--   3. Reconstruccion historica. Permite responder "cuanto stock habia el 15
--      de agosto", cosa imposible con un unico numero que se sobrescribe.
--
-- Sobre id_cliente: el UUID lo genera LA TABLET, no el servidor. Si se corta
-- la conexion justo al enviar, la tablet reintenta con el mismo UUID y el
-- servidor lo descarta por clave primaria duplicada (ON CONFLICT DO NOTHING).
-- Esto es lo que hace la sincronizacion IDEMPOTENTE: reenviar no duplica.
-- -----------------------------------------------------------------------------
CREATE TABLE movimientos_inventario (
    -- Generado en el dispositivo, no en el servidor. Ver nota de idempotencia.
    id              UUID            PRIMARY KEY,
    tienda_id       UUID            NOT NULL REFERENCES tiendas(id)   ON DELETE RESTRICT,
    producto_id     UUID            NOT NULL REFERENCES productos(id) ON DELETE RESTRICT,
    usuario_id      UUID            REFERENCES usuarios(id) ON DELETE SET NULL,
    tipo            tipo_movimiento NOT NULL,

    -- Positiva si entra mercaderia, negativa si sale. El signo lo valida la
    -- restriccion chk_signo_segun_tipo mas abajo.
    cantidad        NUMERIC(12,3)   NOT NULL,

    -- Costo unitario al momento del movimiento. Se congela aca para poder
    -- valorizar el inventario historicamente aunque el proveedor cambie precios.
    costo_unitario  NUMERIC(12,2),

    venta_id        UUID,           -- FK agregada tras crear ventas (ver 3.8)
    motivo          VARCHAR(255),   -- "compra a proveedor", "se rompio al descargar"

    -- Cuando OCURRIO el movimiento en la tienda (lo pone el dispositivo).
    ocurrido_en     TIMESTAMPTZ     NOT NULL,
    -- Cuando LLEGO al servidor. Si la tablet estuvo sin senial, hay diferencia
    -- entre ambas; comparar las dos permite medir el retraso de sincronizacion.
    created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),

    -- Un movimiento de cantidad cero no significa nada.
    CONSTRAINT chk_cantidad_no_cero CHECK (cantidad <> 0),

    -- El signo tiene que ser coherente con el tipo. Sin esto, un error de la
    -- app podria registrar una venta que AUMENTA el stock.
    CONSTRAINT chk_signo_segun_tipo CHECK (
        (tipo IN ('entrada', 'devolucion') AND cantidad > 0) OR
        (tipo IN ('venta',   'merma')      AND cantidad < 0) OR
        (tipo = 'ajuste')
    )
);

-- Indice para el calculo de stock y para el historial de un producto.
CREATE INDEX idx_mov_tienda_producto ON movimientos_inventario(tienda_id, producto_id);
-- Indice para reportes por rango de fechas ("ventas de agosto").
CREATE INDEX idx_mov_fecha           ON movimientos_inventario(tienda_id, ocurrido_en DESC);
CREATE INDEX idx_mov_venta           ON movimientos_inventario(venta_id) WHERE venta_id IS NOT NULL;


-- -----------------------------------------------------------------------------
-- 3.7 STOCK  (cache derivado)
--
-- Contiene el mismo dato que SUM(movimientos), pero ya calculado.
--
-- Por que duplicar: la pantalla de venta consulta el stock en cada tecla que
-- toca el empleado. Sumar miles de movimientos cada vez seria lento. Esta
-- tabla mantiene el total al dia mediante un trigger.
--
-- Compromiso: es dato DERIVADO, no fuente de verdad. Si alguna vez se
-- desincroniza, se regenera con fn_recalcular_stock() (ver seccion 5). La
-- verdad siempre esta en movimientos_inventario.
--
-- cantidad_minima define el umbral de la alerta de reposicion y se configura
-- por tienda: la ferreteria puede querer avisar con 20 tornillos y la
-- plastiqueria con 5 barriles.
-- -----------------------------------------------------------------------------
CREATE TABLE stock (
    tienda_id       UUID          NOT NULL REFERENCES tiendas(id)   ON DELETE CASCADE,
    producto_id     UUID          NOT NULL REFERENCES productos(id) ON DELETE CASCADE,
    cantidad        NUMERIC(12,3) NOT NULL DEFAULT 0,
    cantidad_minima NUMERIC(12,3) NOT NULL DEFAULT 0,
    updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

    -- Clave primaria compuesta: un producto tiene UNA fila de stock por tienda.
    -- Evita de raiz que existan dos filas contradictorias para el mismo par.
    PRIMARY KEY (tienda_id, producto_id)
);

-- Indice parcial: solo indexa las filas bajo el minimo. Es pequenio y hace
-- instantanea la consulta de alertas del panel del duenio.
CREATE INDEX idx_stock_bajo ON stock(tienda_id)
    WHERE cantidad <= cantidad_minima;


-- -----------------------------------------------------------------------------
-- 3.8 VENTAS
--
-- Cabecera de la transaccion: quien vendio, cuando, cuanto y como se pago.
-- El detalle articulo por articulo va en venta_lineas.
-- -----------------------------------------------------------------------------
CREATE TABLE ventas (
    -- Igual que los movimientos: UUID generado en la tablet -> reenviar es seguro.
    id              UUID          PRIMARY KEY,
    tienda_id       UUID          NOT NULL REFERENCES tiendas(id) ON DELETE RESTRICT,
    usuario_id      UUID          REFERENCES usuarios(id) ON DELETE SET NULL,
    caja_id         UUID,         -- FK agregada tras crear cajas (ver 3.10)

    -- Numero de comprobante legible: 'FER-2026-000123'. Unico POR TIENDA, no
    -- global: las dos tiendas numeran en paralelo aunque esten desconectadas.
    numero          VARCHAR(30)   NOT NULL,

    subtotal        NUMERIC(12,2) NOT NULL,
    descuento       NUMERIC(12,2) NOT NULL DEFAULT 0,
    total           NUMERIC(12,2) NOT NULL,
    metodo_pago     metodo_pago   NOT NULL DEFAULT 'efectivo',
    anulada         BOOLEAN       NOT NULL DEFAULT FALSE,
    observaciones   TEXT,

    ocurrido_en     TIMESTAMPTZ   NOT NULL,
    created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_ventas_numero   UNIQUE (tienda_id, numero),
    CONSTRAINT chk_montos         CHECK (subtotal >= 0 AND descuento >= 0 AND total >= 0),
    CONSTRAINT chk_total_coherente CHECK (total = subtotal - descuento)
);

CREATE INDEX idx_ventas_fecha  ON ventas(tienda_id, ocurrido_en DESC);
CREATE INDEX idx_ventas_caja   ON ventas(caja_id) WHERE caja_id IS NOT NULL;

-- Ahora que existe ventas, se puede cerrar la referencia desde movimientos.
ALTER TABLE movimientos_inventario
    ADD CONSTRAINT fk_mov_venta FOREIGN KEY (venta_id)
    REFERENCES ventas(id) ON DELETE SET NULL;


-- -----------------------------------------------------------------------------
-- 3.9 LINEAS DE VENTA
--
-- Cada articulo dentro de una venta.
--
-- Se copian precio_unitario Y costo_unitario del producto en el momento de
-- vender. Es una desnormalizacion DELIBERADA: sin ella, si maniana sube el
-- precio del balde, todos los reportes de ganancia del anio pasado cambiarian
-- solos. Congelando el precio, cada venta conserva su verdad historica.
-- -----------------------------------------------------------------------------
CREATE TABLE venta_lineas (
    id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    venta_id        UUID          NOT NULL REFERENCES ventas(id) ON DELETE CASCADE,
    producto_id     UUID          NOT NULL REFERENCES productos(id) ON DELETE RESTRICT,
    cantidad        NUMERIC(12,3) NOT NULL,
    precio_unitario NUMERIC(12,2) NOT NULL,  -- congelado
    costo_unitario  NUMERIC(12,2) NOT NULL DEFAULT 0,  -- congelado
    subtotal        NUMERIC(12,2) NOT NULL,

    CONSTRAINT chk_linea_cantidad CHECK (cantidad > 0),
    CONSTRAINT chk_linea_subtotal CHECK (subtotal = ROUND(cantidad * precio_unitario, 2))
);

CREATE INDEX idx_lineas_venta    ON venta_lineas(venta_id);
CREATE INDEX idx_lineas_producto ON venta_lineas(producto_id);


-- -----------------------------------------------------------------------------
-- 3.10 CAJAS  (apertura y cierre del turno)
--
-- Una caja se abre al empezar el dia con un monto inicial y se cierra al final
-- contando el efectivo real. La diferencia entre lo esperado y lo contado es
-- exactamente el faltante o sobrante que hoy se descubre a fin de mes sin
-- saber de donde salio.
--
-- esperado y contado se guardan por separado a proposito: si se guardara solo
-- la diferencia, se perderia la posibilidad de auditar cual de los dos numeros
-- estaba mal.
-- -----------------------------------------------------------------------------
CREATE TABLE cajas (
    id                  UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    tienda_id           UUID          NOT NULL REFERENCES tiendas(id) ON DELETE RESTRICT,
    usuario_apertura_id UUID          REFERENCES usuarios(id) ON DELETE SET NULL,
    usuario_cierre_id   UUID          REFERENCES usuarios(id) ON DELETE SET NULL,

    monto_inicial       NUMERIC(12,2) NOT NULL DEFAULT 0,
    efectivo_esperado   NUMERIC(12,2),  -- monto_inicial + ventas en efectivo
    efectivo_contado    NUMERIC(12,2),  -- lo que hay fisicamente en el cajon

    -- Columna GENERADA: la calcula PostgreSQL, no se puede escribir a mano.
    -- Nunca puede quedar inconsistente con los dos valores de arriba.
    diferencia          NUMERIC(12,2)
        GENERATED ALWAYS AS (efectivo_contado - efectivo_esperado) STORED,

    estado              estado_caja   NOT NULL DEFAULT 'abierta',
    abierta_en          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    cerrada_en          TIMESTAMPTZ,
    observaciones       TEXT,

    CONSTRAINT chk_cierre_completo CHECK (
        estado = 'abierta'
        OR (cerrada_en IS NOT NULL AND efectivo_contado IS NOT NULL)
    )
);

-- Indice UNICO PARCIAL: garantiza que una tienda no pueda tener dos cajas
-- abiertas a la vez. La condicion WHERE hace que la restriccion aplique solo
-- a las cajas abiertas; las cerradas pueden ser muchas.
CREATE UNIQUE INDEX uq_caja_abierta_por_tienda ON cajas(tienda_id)
    WHERE estado = 'abierta';

ALTER TABLE ventas
    ADD CONSTRAINT fk_ventas_caja FOREIGN KEY (caja_id)
    REFERENCES cajas(id) ON DELETE SET NULL;


-- -----------------------------------------------------------------------------
-- 3.11 DISPOSITIVOS Y BITACORA DE SINCRONIZACION
--
-- Registra cada tablet y cuando sincronizo por ultima vez. Sirve para que el
-- panel avise "la tablet de la plastiqueria no sincroniza hace 3 horas", que
-- suele ser el primer sintoma de un problema.
-- -----------------------------------------------------------------------------
CREATE TABLE dispositivos (
    id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    tienda_id       UUID         NOT NULL REFERENCES tiendas(id) ON DELETE CASCADE,
    nombre          VARCHAR(100) NOT NULL,   -- "Tablet mostrador ferreteria"
    ultimo_sync     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE sync_log (
    id                  BIGSERIAL   PRIMARY KEY,
    dispositivo_id      UUID        REFERENCES dispositivos(id) ON DELETE CASCADE,
    registros_enviados  INTEGER     NOT NULL DEFAULT 0,
    registros_aceptados INTEGER     NOT NULL DEFAULT 0,
    registros_duplicados INTEGER    NOT NULL DEFAULT 0,  -- descartados por idempotencia
    error               TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_synclog_dispositivo ON sync_log(dispositivo_id, created_at DESC);


-- =============================================================================
-- 4. TRIGGERS DE NEGOCIO
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 4.1 Mantener la tabla stock al dia
--
-- Se dispara con cada movimiento insertado. Si no existe fila de stock para
-- ese par (tienda, producto), la crea; si existe, le suma la cantidad.
-- El UPSERT (INSERT ... ON CONFLICT) resuelve los dos casos en una sola
-- sentencia y de forma atomica, sin condicion de carrera entre dos cajas
-- vendiendo el mismo producto a la vez.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_aplicar_movimiento_a_stock()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO stock (tienda_id, producto_id, cantidad, updated_at)
    VALUES (NEW.tienda_id, NEW.producto_id, NEW.cantidad, NOW())
    ON CONFLICT (tienda_id, producto_id) DO UPDATE
        SET cantidad   = stock.cantidad + EXCLUDED.cantidad,
            updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_movimiento_actualiza_stock
    AFTER INSERT ON movimientos_inventario
    FOR EACH ROW EXECUTE FUNCTION fn_aplicar_movimiento_a_stock();


-- -----------------------------------------------------------------------------
-- 4.2 Proteger el caracter append-only del historial
--
-- Impide fisicamente modificar o borrar un movimiento ya registrado. Ni la
-- aplicacion ni alguien conectado con psql pueden alterar el historial: la
-- unica forma de corregir es insertar un movimiento de 'ajuste'.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_bloquear_modificacion()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION
        'movimientos_inventario es de solo insercion: registre un movimiento de ajuste en lugar de modificar el historial';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_movimientos_inmutables
    BEFORE UPDATE OR DELETE ON movimientos_inventario
    FOR EACH ROW EXECUTE FUNCTION fn_bloquear_modificacion();


-- =============================================================================
-- 5. FUNCION DE RECONCILIACION
--
-- Recalcula la tabla stock desde cero a partir de los movimientos. Es la red
-- de seguridad del cache: si por un bug o una carga manual el stock quedara
-- desalineado, esta funcion lo devuelve a la verdad.
--
-- Devuelve las filas que estaban mal, para poder auditar que se corrigio.
-- =============================================================================
CREATE OR REPLACE FUNCTION fn_recalcular_stock(p_tienda_id UUID DEFAULT NULL)
RETURNS TABLE (
    tienda_id       UUID,
    producto_id     UUID,
    cantidad_previa NUMERIC,
    cantidad_real   NUMERIC
) AS $$
BEGIN
    RETURN QUERY
    -- 1) Verdad: el total que surge de sumar los movimientos.
    WITH calculado AS (
        SELECT m.tienda_id, m.producto_id, SUM(m.cantidad) AS total
        FROM movimientos_inventario m
        WHERE p_tienda_id IS NULL OR m.tienda_id = p_tienda_id
        GROUP BY m.tienda_id, m.producto_id
    ),
    -- 2) Diferencias, capturadas ANTES de tocar nada. Hacerlo en un paso
    --    separado es lo que permite informar el valor previo sin depender
    --    del orden de evaluacion del UPDATE.
    diferencias AS (
        SELECT c.tienda_id, c.producto_id, s.cantidad AS previa, c.total AS nueva
        FROM calculado c
        JOIN stock s
          ON s.tienda_id = c.tienda_id AND s.producto_id = c.producto_id
        WHERE s.cantidad IS DISTINCT FROM c.total
    ),
    -- 3) Correccion. Un CTE que modifica datos se ejecuta siempre y por
    --    completo, aunque la consulta principal no lea su salida.
    corregidas AS (
        UPDATE stock s
        SET cantidad = d.nueva, updated_at = NOW()
        FROM diferencias d
        WHERE s.tienda_id = d.tienda_id AND s.producto_id = d.producto_id
        RETURNING 1
    )
    SELECT d.tienda_id, d.producto_id, d.previa, d.nueva FROM diferencias d;
END;
$$ LANGUAGE plpgsql;


-- =============================================================================
-- 6. VISTAS DE CONSULTA
--
-- Encapsulan los JOIN que el panel del duenio necesita, para que la aplicacion
-- no repita la misma logica en varios lugares.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 6.1 Inventario valorizado: cuanta plata hay parada en mercaderia
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_inventario_valorizado AS
SELECT
    t.id                                 AS tienda_id,
    t.nombre                             AS tienda,
    p.id                                 AS producto_id,
    p.codigo,
    p.nombre                             AS producto,
    s.cantidad,
    s.cantidad_minima,
    p.precio_costo,
    p.precio_venta,
    ROUND(s.cantidad * p.precio_costo, 2) AS valor_costo,
    ROUND(s.cantidad * p.precio_venta, 2) AS valor_venta,
    (s.cantidad <= s.cantidad_minima)     AS necesita_reposicion
FROM stock s
JOIN tiendas   t ON t.id = s.tienda_id
JOIN productos p ON p.id = s.producto_id
WHERE p.activo;


-- -----------------------------------------------------------------------------
-- 6.2 Ventas por dia y por tienda, con ganancia real
--
-- Responde la pregunta que hoy nadie puede contestar sin sentarse dos horas:
-- no cuanto se VENDIO, sino cuanto se GANO.
--
-- CUIDADO -- ERROR DE AGREGACION POR FAN-OUT:
-- La tentacion es unir ventas con venta_lineas y sumar todo junto. Esta mal.
-- El JOIN multiplica la cabecera por cada linea: una venta de Bs 125 con dos
-- articulos aparece DOS veces, y SUM(v.total) devuelve 250 en lugar de 125.
-- La ganancia sale inflada y nadie lo nota, porque el numero parece razonable.
--
-- La solucion es agregar las lineas PRIMERO (CTE costos, una fila por venta) y
-- recien despues unirlas a la cabecera. Asi cada venta se cuenta una sola vez.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_ventas_diarias AS
WITH costos AS (
    -- Una unica fila por venta: cuanto costo la mercaderia que salio.
    SELECT l.venta_id, SUM(l.cantidad * l.costo_unitario) AS costo
    FROM venta_lineas l
    GROUP BY l.venta_id
)
SELECT
    v.tienda_id,
    t.nombre                                  AS tienda,
    DATE(v.ocurrido_en)                       AS fecha,
    COUNT(*)                                  AS cantidad_ventas,
    SUM(v.total)                              AS total_vendido,
    SUM(COALESCE(c.costo, 0))                 AS costo_mercaderia,
    SUM(v.total) - SUM(COALESCE(c.costo, 0))  AS ganancia_bruta,
    ROUND(AVG(v.total), 2)                    AS ticket_promedio
FROM ventas v
JOIN tiendas t ON t.id = v.tienda_id
-- LEFT JOIN: una venta sin lineas cargadas igual debe figurar en el reporte,
-- con costo cero, en lugar de desaparecer silenciosamente.
LEFT JOIN costos c ON c.venta_id = v.id
WHERE NOT v.anulada
GROUP BY v.tienda_id, t.nombre, DATE(v.ocurrido_en);


-- -----------------------------------------------------------------------------
-- 6.3 Productos que necesitan reposicion (alimenta las alertas del panel)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_alertas_stock AS
SELECT
    t.nombre    AS tienda,
    p.codigo,
    p.nombre    AS producto,
    s.cantidad,
    s.cantidad_minima,
    p.unidad_medida
FROM stock s
JOIN tiendas   t ON t.id = s.tienda_id
JOIN productos p ON p.id = s.producto_id
WHERE p.activo
  AND s.cantidad <= s.cantidad_minima
ORDER BY (s.cantidad - s.cantidad_minima) ASC;


COMMIT;

-- =============================================================================
-- FIN DEL ESQUEMA
-- =============================================================================
