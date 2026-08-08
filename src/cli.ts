#!/usr/bin/env node
import { startStdioServer } from './server/transports/stdio.js';
import { parseArgs, UsageError, USAGE } from './cli/parse.js';
import { runCommand } from './cli/commands.js';
import { VERSION } from './version.js';

/**
 * Single entry point for both surfaces.
 *
 * No arguments starts the MCP stdio server — the behaviour every MCP client
 * config depends on, unchanged. A subcommand runs that computation and exits.
 *
 * There is deliberately only one `bin`: two bins whose names do not match the
 * package name make `npx -y axiom-advanced-math-mcp` fail outright with
 * "could not determine executable to run", and that is the line in every MCP
 * client config.
 */
async function main(): Promise<number> {
  let command;
  try {
    command = parseArgs(process.argv.slice(2));
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`axiom-mcp: ${err.message}\n`);
      console.error(USAGE);
      return 1;
    }
    throw err;
  }

  switch (command.kind) {
    case 'help':
      // Help is requested output, so it goes to stdout.
      console.log(USAGE);
      return 0;

    case 'version':
      console.log(VERSION);
      return 0;

    case 'server':
      if (process.stdin.isTTY) {
        // A human ran this by hand. stdout belongs to the protocol, so the hint
        // goes to stderr where it cannot corrupt a client's stream.
        console.error(
          'axiom-mcp: starting as an MCP stdio server (waiting for JSON-RPC on stdin).\n' +
            'For one-off computations try: axiom-mcp compute \'2+2\'   ·   axiom-mcp --help'
        );
      }
      await startStdioServer();
      // The server owns the process from here; it exits on transport close.
      return -1;

    default:
      return runCommand(command);
  }
}

main()
  .then((code) => {
    if (code >= 0) process.exit(code);
  })
  .catch((err) => {
    console.error(`axiom-mcp: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
