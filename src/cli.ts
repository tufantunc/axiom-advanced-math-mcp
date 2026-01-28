import { startStdioServer, startHttpServer } from './server/transports/stdio.js';

const args = process.argv.slice(2);

if (args.includes('--transport') && args.includes('http')) {
  const portIndex = args.indexOf('--port');
  const port = portIndex > 0 ? parseInt(args[portIndex + 1]) : 3000;
  startHttpServer(port);
} else {
  startStdioServer();
}


