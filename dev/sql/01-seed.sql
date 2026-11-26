/* Base de pruebas "POS". Solo para desarrollo: borra y recrea las tablas. */
IF DB_ID('POS') IS NULL CREATE DATABASE [POS];
GO
USE [POS];
GO
IF OBJECT_ID('dbo.OrderItems') IS NOT NULL DROP TABLE dbo.OrderItems;
IF OBJECT_ID('dbo.Orders')     IS NOT NULL DROP TABLE dbo.Orders;
IF OBJECT_ID('dbo.Stock')      IS NOT NULL DROP TABLE dbo.Stock;
IF OBJECT_ID('dbo.Products')   IS NOT NULL DROP TABLE dbo.Products;
GO
-- S1 rowversion (con índice, el caso ideal)
CREATE TABLE dbo.Orders (
  OrderId int IDENTITY(1,1) PRIMARY KEY,
  Status  nvarchar(20)  NOT NULL,
  Total   decimal(12,2) NOT NULL DEFAULT 0,
  RowVer  rowversion    NOT NULL
);
CREATE INDEX IX_Orders_RowVer ON dbo.Orders(RowVer);
-- S3 pkWindow
CREATE TABLE dbo.OrderItems (
  ItemId  int IDENTITY(1,1) PRIMARY KEY,
  OrderId int NOT NULL,
  Sku     nvarchar(30) NOT NULL,
  Qty     int NOT NULL,
  Price   decimal(12,2) NOT NULL
);
-- S2 modifiedAt (con índice)
CREATE TABLE dbo.Stock (
  ProductId    int PRIMARY KEY,
  Sku          nvarchar(30) NOT NULL,
  OnHand       int NOT NULL,
  LastModified datetime NOT NULL DEFAULT GETDATE()
);
CREATE INDEX IX_Stock_LastModified ON dbo.Stock(LastModified);
-- S4 hashDiff (sin marca de cambio)
CREATE TABLE dbo.Products (
  ProductId int PRIMARY KEY,
  Name      nvarchar(100) NOT NULL,
  Price     decimal(12,2) NOT NULL
);
GO
INSERT dbo.Products(ProductId, Name, Price) VALUES (1,N'Café',35),(2,N'Té',28),(3,N'Pan dulce',18),(4,N'Jugo',32);
INSERT dbo.Stock(ProductId, Sku, OnHand)    VALUES (1,'SKU-1',50),(2,'SKU-2',40),(3,'SKU-3',30),(4,'SKU-4',20);
INSERT dbo.Orders(Status, Total)            VALUES (N'paid',63),(N'open',0);
INSERT dbo.OrderItems(OrderId, Sku, Qty, Price) VALUES (1,'SKU-1',1,35),(1,'SKU-2',1,28),(2,'SKU-3',2,18);
GO
SELECT 'Sembrado OK' AS resultado, (SELECT COUNT(*) FROM dbo.Orders) AS ordenes, (SELECT COUNT(*) FROM dbo.Products) AS productos;
GO
