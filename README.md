# Axiom-MCP: The Advanced Math Engine for LLMs

Axiom-MCP gives Large Language Models (Claude, etc.) the ability to perform rigorous scientific and financial calculations. Unlike standard calculator tools, Axiom acts as a bridge to a full Computer Algebra System (CAS).

### 🚀 Features
- **Symbolic Computation:** Solve integrals, derivatives, and limits with steps (via Giac/Xcas).
- **Financial Analysis:** Process large time-series datasets (e.g., Bitcoin OHLCV) for volatility, regression, and stochastic modeling.
- **Hybrid Architecture:**
  - 🟢 **Local Mode:** Runs entirely on your machine using WebAssembly and mathjs. Free and privacy-focused.
  - ☁️ **Axiom Cloud (Coming Soon):** Offload heavy computations (Monte Carlo simulations, 500k+ row datasets) to our high-performance clusters via API key.

### 🛠 Tech Stack
- **Core:** TypeScript, Node.js
- **Math Engines:** Giac/Xcas (Wasm), mathjs, numeric
- **Protocol:** Model Context Protocol (MCP) over Stdio & SSE
