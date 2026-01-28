# Giac Integration

This directory contains the Giac Computer Algebra System integration for the Axiom MCP server.

## Implementation

Currently, the project uses the native giac npm package for Node.js. This provides:

- Native C++ performance
- Full Giac/Xcas functionality
- Symbolic computation capabilities

### Future: WASM Support

The project is designed to be flexible and can easily switch to WebAssembly implementation:

1. Build giac.wasm from [GeoGebra/giac](https://github.com/geogebra/giac)
2. Copy `giac.wasm.js` to this directory
3. Update `wrapper.ts` to use WASM instead of native module

### Installing Native giac

**Linux:**
```bash
sudo apt install libgmp-dev libmpfr-dev
npm install giac
```

**macOS:**
```bash
sudo port install gmp mpfr
npm install giac
```

**Windows:**
1. Install Visual Studio 2013
2. Install node-gyp
3. Download MPIR and MPFR precompiled binaries
4. Run `npm install giac`

For detailed instructions, see [giac README](https://github.com/geogebra/giac/tree/master/src/nodegiac).

## Files

- `interface.ts` - GiacEngine interface for pluggable implementations
- `wrapper.ts` - Node.js native binding implementation
- `index.ts` - Service layer for Giac operations
- `giac.wasm.js` - Placeholder for future WASM implementation
