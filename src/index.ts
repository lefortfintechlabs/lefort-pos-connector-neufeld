#!/usr/bin/env node
import { HELP, configCheck, diagnostics, parseArgs, queue, run, status, testSqlServer, testWebhook } from './commands';
import { VERSION } from './version';

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  switch (args.command) {
    case 'run':
      return run(args);
    case 'status':
      return status(args);
    case 'queue':
      return queue(args);
    case 'config-check':
      return configCheck(args);
    case 'test-sqlserver':
      return testSqlServer(args);
    case 'test-webhook':
      return testWebhook(args);
    case 'diagnostics':
      return diagnostics(args);
    case 'version':
      console.log(VERSION);
      return 0;
    default:
      console.log(HELP);
      return args.command === 'help' ? 0 : 1;
  }
}

main().then(
  (code) => process.exit(code),
  (err: Error) => {
    console.error(err.message);
    process.exit(1);
  }
);
