/* Acceso de solo lectura para el conector (variante B del script del instalador). Ejecutar como sa. */
USE [master];
GO
IF SUSER_ID('lefort_ro') IS NOT NULL DROP LOGIN [lefort_ro];
CREATE LOGIN [lefort_ro] WITH PASSWORD = N'Lefort_Ro_Passw0rd!', CHECK_POLICY = OFF, DEFAULT_DATABASE = [POS];
GO
USE [POS];
GO
IF USER_ID('lefort_ro') IS NOT NULL DROP USER [lefort_ro];
CREATE USER [lefort_ro] FOR LOGIN [lefort_ro];
GRANT SELECT ON OBJECT::dbo.Orders     TO [lefort_ro];
GRANT SELECT ON OBJECT::dbo.OrderItems TO [lefort_ro];
GRANT SELECT ON OBJECT::dbo.Stock      TO [lefort_ro];
GRANT SELECT ON OBJECT::dbo.Products   TO [lefort_ro];
ALTER ROLE db_denydatawriter ADD MEMBER [lefort_ro];
ALTER ROLE db_denyddladmin   ADD MEMBER [lefort_ro];
GO
SELECT 'Acceso de solo lectura creado' AS resultado;
GO
