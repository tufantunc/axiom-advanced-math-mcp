#!/usr/bin/env node
import { startStdioServer } from './server/transports/stdio.js';
import { parseArgs, UsageError, USAGE, topicUsage } from './cli/parse.js';
import { runCommand } from './cli/commands.js';
import { VERSION } from './version.js';

/**
 * Single entry point for both surfaces.
 *
 * No arguments starts the MCP stdio server — the behaviour every MCP client
 * config depends on, unchanged. A subcommand runs that computation and exits.
 *
 * There is deliberately only one `bin`, and it is named after the package.
 * `npx -y axiom-math` is the line in every MCP client config, so how npm
 * resolves it is part of this project's public contract: with a single bin npx
 * runs it whatever it is called (measured), but adding a second one makes the
 * choice ambiguous. Matching the package name removes the ambiguity entirely
 * and keeps one name for the package, the command and the MCP server identity.
 */
async function main(): Promise<number | null> {
  let command;
  try {
    command = parseArgs(process.argv.slice(2));
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`axiom-math: ${err.message}\n`);
      console.error(USAGE);
      return 1;
    }
    throw err;
  }

  switch (command.kind) {
    case 'help':
      // Help is requested output, so it goes to stdout. A subcommand topic
      // gets its own focused text; otherwise the global usage.
      console.log(topicUsage(command.topic));
      return 0;

    case 'version':
      console.log(VERSION);
      return 0;

    case 'server':
      if (process.stdin.isTTY) {
        // A human ran this by hand. stdout belongs to the protocol, so the hint
        // goes to stderr where it cannot corrupt a client's stream.
        console.error(
          'axiom-math: starting as an MCP stdio server (waiting for JSON-RPC on stdin).\n' +
            "For one-off computations try: axiom-math compute '2+2'   ·   axiom-math --help"
        );
      }
      await startStdioServer();
      // null, not an exit code: the server owns the process from here and exits
      // on transport close. A sentinel number would share the exit-code channel
      // with real codes, which is how a "-1 means keep running" convention turns
      // into an accidental exit status.
      return null;

    default:
      return runCommand(command);
  }
}

/**
 * Sets the exit code; never calls `process.exit()`.
 *
 * `process.exit()` terminates without draining stdout, and writes to a **pipe**
 * are asynchronous. Measured before this was fixed: `expand((x+1)^900)` wrote
 * 181,227 bytes to a file but only 65,728 through `$(...)` — truncated mid-number
 * and still exit 0. That is the silent-wrong-answer failure this CLI exists to
 * prevent, delivered by the CLI itself, on the exact `ANSWER=$(...)` pattern the
 * agent skill teaches.
 *
 * Setting `exitCode` lets Node flush and exit on its own. Nothing keeps the loop
 * open: both worker children — Giac and js-compute — are `unref()`d by their
 * hosts, along with their IPC channels.
 */
function finish(code: number): void {
  process.exitCode = code;
}

main()
  .then((code) => {
    if (code !== null) finish(code);
  })
  .catch((err) => {
    console.error(`axiom-math: ${err instanceof Error ? err.message : String(err)}`);
    finish(1);
  });
