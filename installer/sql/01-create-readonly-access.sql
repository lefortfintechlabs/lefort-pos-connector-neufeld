/*
  Lefort POS Connector - acceso de SOLO LECTURA (ejecutar UNA vez, como administrador).

  Es un cambio de seguridad, no de datos ni de esquema: no crea tablas, índices, triggers
  ni modifica la configuración de la instancia. Ajuste los marcadores <...> antes de ejecutar.

  Variante A (recomendada): cuenta virtual del servicio de Windows (sin contraseña).
  Variante B: inicio de sesión SQL dedicado (requiere modo de autenticación mixto ya habilitado).
*/
USE [master];
GO

-- Variante A ---------------------------------------------------------------
CREATE LOGIN [NT SERVICE\LefortPOSConnector] FROM WINDOWS WITH DEFAULT_DATABASE = [master];

-- Variante B (descomente y comente la A) -----------------------------------
-- CREATE LOGIN [lefort_connector] WITH PASSWORD = N'<CONTRASEÑA-LARGA>', CHECK_POLICY = ON, DEFAULT_DATABASE = [master];
GO

USE [<BASE_DE_DATOS_POS>];
GO

CREATE USER [lefort_connector] FOR LOGIN [NT SERVICE\LefortPOSConnector];   -- Variante B: FOR LOGIN [lefort_connector]
GO

-- SELECT únicamente sobre las tablas configuradas (no db_datareader completo).
GRANT SELECT ON OBJECT::[dbo].[Orders]     TO [lefort_connector];
GRANT SELECT ON OBJECT::[dbo].[OrderItems] TO [lefort_connector];
GRANT SELECT ON OBJECT::[dbo].[Stock]      TO [lefort_connector];
GRANT SELECT ON OBJECT::[dbo].[Products]   TO [lefort_connector];
GO

-- Denegación explícita de escritura (defensa en profundidad; DENY prevalece sobre cualquier GRANT).
ALTER ROLE db_denydatawriter ADD MEMBER [lefort_connector];
ALTER ROLE db_denyddladmin   ADD MEMBER [lefort_connector];
GO

-- Verificación: debe devolver SELECT=1 y INSERT/UPDATE/DELETE/ALTER=0
EXECUTE AS USER = 'lefort_connector';
SELECT HAS_PERMS_BY_NAME('dbo.Orders', 'OBJECT', 'SELECT') AS can_select,
       HAS_PERMS_BY_NAME('dbo.Orders', 'OBJECT', 'INSERT') AS can_insert,
       HAS_PERMS_BY_NAME('dbo.Orders', 'OBJECT', 'UPDATE') AS can_update,
       HAS_PERMS_BY_NAME('dbo.Orders', 'OBJECT', 'DELETE') AS can_delete,
       HAS_PERMS_BY_NAME('dbo.Orders', 'OBJECT', 'ALTER')  AS can_alter;
REVERT;
GO
