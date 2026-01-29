FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./

RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

FROM node:20-alpine

RUN apk add --no-cache \
    gmp-dev \
    mpfr-dev \
    python3 \
    make \
    g++ \
    git

WORKDIR /app

ENV GIAC_ENGINE=native

COPY package*.json ./
RUN npm ci --production

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src/server/giac ./src/server/giac

COPY src/server/giac/README.md ./src/server/giac/README.md

ENV NODE_ENV=production
ENV MCP_TRANSPORT=stdio

EXPOSE 3000

CMD ["npm", "start"]
