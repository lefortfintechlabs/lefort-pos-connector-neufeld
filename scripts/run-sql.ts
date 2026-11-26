/**
 * Ejecuta un archivo .sql (con separadores GO) contra SQL Server, sin necesitar sqlcmd.
 *   npm run dev:sql -- dev/sql/01-seed.sql
 * Variables: SQL_SERVER (localhost) SQL_PORT (1433) SQL_USER (sa) SQL_PASSWORD (o MSSQL_SA_PASSWORD) SQL_DATABASE (master)
 */
import fs from 'node:fs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const sql = require('mssql');

export function splitBatches(text: string): string[] {
  return text
    .split(/^\s*GO\s*$/gim)
    .map((b) => b.trim())
    .filter(Boolean);
}

async function main() {
  const file = process.argv[2];
  if (!file) throw new Error('Uso: npm run dev:sql -- archivo.sql');
  const pool = new sql.ConnectionPool({
    server: process.env.SQL_SERVER ?? 'localhost',
    port: Number(process.env.SQL_PORT ?? 1433),
    user: process.env.SQL_USER ?? 'sa',
    password: process.env.SQL_PASSWORD ?? process.env.MSSQL_SA_PASSWORD ?? 'Lefort_Sa_Passw0rd!',
    database: process.env.SQL_DATABASE ?? 'master',
    // Una sola conexión: USE, EXECUTE AS y REVERT deben compartir sesión entre lotes.
    pool: { min: 1, max: 1 },
    options: { encrypt: false, trustServerCertificate: true },
    requestTimeout: 60000
  });
  await pool.connect();
  try {
    for (const batch of splitBatches(fs.readFileSync(file, 'utf8'))) {
      const res = await pool.request().batch(batch);
      for (const rs of res.recordsets as unknown[][]) if (rs.length) console.table(rs);
    }
  } finally {
    await pool.close();
  }
}

if (require.main === module) {
  main().catch((e: Error) => {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  });
}
