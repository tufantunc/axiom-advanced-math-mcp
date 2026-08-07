/**
 * The single source of truth for the server version.
 *
 * Kept in sync with package.json by test/version.test.ts. The MCP server
 * reports this in `serverInfo`, so a mismatch is visible to every client.
 */
export const VERSION = '0.2.0';
