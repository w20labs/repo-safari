# --- build: install everything (with a toolchain for native modules), typecheck, bundle the client ---
FROM node:24-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

# --- runtime: pruned node_modules (native modules already compiled), server sources run with tsx, built client ---
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8787 DB_PATH=/data/lcs.db
COPY package.json package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY server ./server
COPY shared ./shared
COPY scripts ./scripts
COPY assets ./assets
EXPOSE 8787
CMD ["npm", "start"]
