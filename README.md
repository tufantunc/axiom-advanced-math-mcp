# Axiom Advanced Math MCP Server

Advanced mathematical computation engine for LLMs powered by the Model Context Protocol.

## Features

- **Quick Calc**: Fast numerical calculations using math.js
  - Arithmetic operations
  - Unit conversions
  - Trigonometric functions
  - Matrix operations
  - Complex numbers

- **Advanced Solve**: Symbolic computation using Giac/Xcas
  - Symbolic integration
  - Derivatives
  - Limits
  - Equation solving
  - Differential equations

- **Multiple Transports**:
  - Stdio (for local Claude Desktop integration)
  - HTTP/SSE (for remote access)
  - Streamable HTTP (modern transport)

## Installation

```bash
npm install
```

## Usage

### CLI

```bash
# Run with stdio transport (default)
npm start

# Run HTTP server
npm run start:http

# Development mode
npm run dev
```

### Docker

```bash
docker-compose up
```

## Configuration

Environment variables:

- `MCP_TRANSPORT`: Transport type (stdio | http)
- `MCP_PORT`: HTTP server port (default: 3000)
- `MCP_HOST`: HTTP server host (default: 127.0.0.1)

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Run tests
npm test

# Lint
npm run lint

# Format
npm run format
```

## License

MIT
