FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY . .
ENV NODE_ENV=production PORT=8081 TRUST_PROXY=1 ORIGIN=https://metastocker.net
USER 1001:1001
CMD ["node", "server.mjs"]
