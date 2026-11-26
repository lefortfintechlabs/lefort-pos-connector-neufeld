import { describe, expect, it } from 'vitest';
import { assertReadOnlySelect, ReadOnlyViolation } from '../src/db/sqlGuard';

describe('guardia de solo lectura', () => {
  it('acepta SELECT paginados y funciones de metadatos', () => {
    for (const sql of [
      'SELECT TOP (@n) [Id] AS [Id] FROM [dbo].[Orders] WHERE [RowVer] > @wm ORDER BY [RowVer] ASC',
      'SELECT MIN_ACTIVE_ROWVERSION() AS v',
      "SELECT HAS_PERMS_BY_NAME(@o, 'OBJECT', 'INSERT') AS i",
      'SELECT [Update] AS [Update], [Delete] AS [Delete] FROM [dbo].[Raro]',
      "SELECT [Id] FROM [dbo].[T] WHERE [Notas] = 'DROP TABLE x'"
    ]) {
      expect(() => assertReadOnlySelect(sql), sql).not.toThrow();
    }
  });

  it.each([
    ['INSERT', "INSERT INTO [dbo].[T]([a]) VALUES (1)"],
    ['UPDATE', 'UPDATE [dbo].[T] SET [a] = 1'],
    ['DELETE', 'DELETE FROM [dbo].[T]'],
    ['MERGE', 'MERGE [dbo].[T] AS t USING s ON 1=1 WHEN MATCHED THEN DELETE;'],
    ['SELECT INTO', 'SELECT [a] INTO [dbo].[Copia] FROM [dbo].[T]'],
    ['varias sentencias', 'SELECT 1; DROP TABLE [dbo].[T]'],
    ['EXEC', 'EXEC sp_who'],
    ['SET', 'SET NOCOUNT ON'],
    ['comentario', 'SELECT 1 -- ; DROP TABLE x'],
    ['comentario en bloque', 'SELECT 1 /* x */'],
    ['inyección con ALTER', 'SELECT 1 WHERE 1=1 ALTER TABLE x ADD y int'],
    ['xp_cmdshell', "SELECT xp_cmdshell('dir')"],
    ['no inicia con SELECT', 'WITH x AS (SELECT 1) SELECT * FROM x']
  ])('rechaza %s', (_name, sql) => {
    expect(() => assertReadOnlySelect(sql)).toThrow(ReadOnlyViolation);
  });
});
