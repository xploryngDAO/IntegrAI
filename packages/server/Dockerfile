# syntax=docker/dockerfile:1.7
# SAC Hub API image (build context = repository root)
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY apps/web/package.json apps/web/
COPY vendor ./vendor
RUN npm ci --no-audit --no-fund

FROM deps AS build
COPY tsconfig.base.json ./
COPY prisma ./prisma
COPY prisma.config.ts ./
COPY packages/shared ./packages/shared
COPY packages/server ./packages/server
# Prisma ORM 7: the generated client is plain TypeScript under
# `packages/server/src/generated` (gitignored), so it must be generated before
# `tsc`. `prisma generate` needs no database connection.
RUN npm run build:shared \
 && npx prisma generate \
 && npm run build:server \
 && npm prune --omit=dev

FROM node:22-alpine AS runtime
WORKDIR /app
# Build identity for GET /version (deploy verification); CI passes the SHA.
ARG GIT_SHA=""
ENV GIT_SHA=${GIT_SHA}
ENV NODE_ENV=production
RUN apk add --no-cache openssl tini \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/server/package.json ./packages/server/package.json
COPY --from=build /app/packages/server/dist ./packages/server/dist
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/prisma.config.ts ./prisma.config.ts
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4000/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/sbin/tini", "--"]
# Apply pending migrations, then boot. Safe to run on every container start.
# `prisma` runs directly (no npm/npx in the runtime image: the bundled npm CLI
# was the source of high-severity advisories and is not needed at runtime).
CMD ["sh", "-c", "node node_modules/prisma/build/index.js migrate deploy && node packages/server/dist/index.js"]
