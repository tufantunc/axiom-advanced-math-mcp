import { startStdioServer } from './server/transports/stdio.js';

startStdioServer().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
