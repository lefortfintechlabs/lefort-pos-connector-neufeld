import fs from 'node:fs';
import path from 'node:path';

function read(): string {
  try {
    const p = path.resolve(__dirname, '..', 'package.json');
    return (JSON.parse(fs.readFileSync(p, 'utf8')) as { version: string }).version;
  } catch {
    return '0.0.0';
  }
}

export const VERSION = read();
