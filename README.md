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
# Build and run (Linux/Mac)
docker-compose up -d

# Check logs
docker-compose logs -f

# Stop
docker-compose down
```

### WASM Build (Cross-platform)

The project supports building Giac WASM which works across all platforms (x86_64, ARM64, Windows):

**Linux/Mac:**

```bash
# Build WASM on Linux/Mac (uses Docker x86_64 emulation)
cd docker
docker-compose -f docker-compose.wasm.win build
```

**Windows:**

```bash
# Build WASM on Windows (uses Docker Desktop)
cd docker
docker-compose -f docker-compose.windows.yml build
```

**WASM Build Notes:**

- Build creates cross-platform WASM that works on ARM64, x86_64, and Windows
- Uses Docker x86_64 emulation to build on ARM64/Mac
- Build takes 10-20 minutes on first run, 5-10 minutes on subsequent runs (Docker caching)
- Output files: `giac.wasm` and `giac.wasm.js`
- Copy artifacts from `docker/wasm-output/` to `src/server/giac/` after build

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

# Run tests with coverage
npm run test:coverage

# Lint
npm run lint

# Format
npm run format
```

## Testing

The project includes comprehensive unit tests:

- **Quick Calc Tests**: 27 tests covering arithmetic, trigonometry, logarithms, complex numbers, and error handling
- **Advanced Solve Tests**: 37 tests covering integration, differentiation, limits, equation solving, factorization, expansion, simplification, and differential equations

All tests pass with 100% success rate.

## License

MIT
