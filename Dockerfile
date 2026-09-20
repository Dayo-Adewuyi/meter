# Pinned by digest, not by tag: a tag can be repointed at a different image.
FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS build
ENV CI=true
WORKDIR /app
# Corepack verifies the pnpm tarball against the hash in package.json.
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/
COPY packages/config/package.json packages/config/
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY . .
RUN pnpm --filter @meter/server build && pnpm deploy --filter @meter/server --prod --legacy /out

FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
EXPOSE 3001
CMD ["node", "dist/bootstrap/api.js"]
