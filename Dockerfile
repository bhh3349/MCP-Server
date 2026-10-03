# MCP-Server 网关：一键构建、一键运行
#   docker build -t mcp-gateway .
#   docker run -d --name mcp-gateway -p 8080:8080 \
#     -e GATEWAY_TOKENS=<64hex> [-e GATEWAY_PUBLIC_URL=wss://gw.example.com] \
#     mcp-gateway

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
EXPOSE 8080
ENV GATEWAY_PORT=8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:8080/healthz | grep -q '"ok":true'
CMD ["node", "dist/gateway/cli.js"]
