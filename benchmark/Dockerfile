FROM node:24-slim

# Install main project dependencies (MCP server)
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

# Copy main project source
COPY src/ ./src/
COPY tsconfig.json ./

# Install benchmark project dependencies
WORKDIR /app/benchmark
COPY benchmark/package*.json ./
RUN npm ci

# Copy benchmark source
COPY benchmark/ ./

CMD ["npm", "run", "quick"]
