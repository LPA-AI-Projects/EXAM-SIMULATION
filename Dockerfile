FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js storage-shim.js index.html comptia_cysa_plus_simulation.html railway.json ./

ENV NODE_ENV=production

CMD ["node", "server.js"]
