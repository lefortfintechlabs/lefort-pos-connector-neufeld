/* Simula la actividad del POS (se ejecuta como sa). Repetir varias veces mientras corre el conector. */
USE [POS];
GO
INSERT dbo.Orders(Status, Total) VALUES (N'open', 0);
DECLARE @id int = SCOPE_IDENTITY();
INSERT dbo.OrderItems(OrderId, Sku, Qty, Price) VALUES (@id,'SKU-1',2,35),(@id,'SKU-4',1,32);
UPDATE dbo.Orders SET Status = N'paid', Total = 102 WHERE OrderId = @id;           -- S1: rowversion cambia solo
UPDATE dbo.Stock  SET OnHand = OnHand - 1, LastModified = GETDATE() WHERE ProductId = 1;  -- S2: el POS debe actualizar la fecha
UPDATE dbo.Products SET Price = Price + 1 WHERE ProductId = 2;                     -- S4: se verá en el siguiente barrido
GO
SELECT 'Actividad simulada' AS resultado, (SELECT COUNT(*) FROM dbo.Orders) AS ordenes;
GO
