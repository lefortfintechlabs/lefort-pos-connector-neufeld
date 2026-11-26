/**
 * Defensa en profundidad del principio de solo lectura (SDD §1 y §6).
 * Toda consulta enviada a SQL Server pasa por aquí: una sola sentencia SELECT, sin SELECT INTO,
 * sin EXEC, sin DML/DDL, sin comentarios. Los identificadores entre corchetes y los literales
 * de texto se ignoran al buscar palabras prohibidas.
 */
const FORBIDDEN =
  /\b(INSERT|UPDATE|DELETE|MERGE|DROP|ALTER|CREATE|TRUNCATE|EXEC|EXECUTE|INTO|GRANT|REVOKE|DENY|BACKUP|RESTORE|DBCC|OPENROWSET|OPENQUERY|OPENDATASOURCE|BULK|SHUTDOWN|WAITFOR|KILL|USE|DECLARE|SET|XP_\w*|SP_\w*)\b/i;

export class ReadOnlyViolation extends Error {
  constructor(reason: string, public readonly sql: string) {
    super(`Consulta rechazada por el guardia de solo lectura: ${reason}`);
    this.name = 'ReadOnlyViolation';
  }
}

export function assertReadOnlySelect(sql: string): void {
  if (/--|\/\*|\*\//.test(sql)) throw new ReadOnlyViolation('no se permiten comentarios', sql);
  const stripped = sql.replace(/'(?:[^']|'')*'/g, "''").replace(/\[(?:[^\]]|\]\])*\]/g, '[]');
  if (!/^\s*SELECT\b/i.test(stripped)) throw new ReadOnlyViolation('debe iniciar con SELECT', sql);
  if (stripped.includes(';')) throw new ReadOnlyViolation('solo se permite una sentencia', sql);
  const hit = FORBIDDEN.exec(stripped);
  if (hit) throw new ReadOnlyViolation(`palabra prohibida: ${hit[1]}`, sql);
}
