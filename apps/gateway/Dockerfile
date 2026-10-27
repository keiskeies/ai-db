# AiDB Bridge — standalone gateway (headless server / Linux deployment)
FROM node:24-bookworm-slim AS build
WORKDIR /repo
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/package.json
COPY apps/gateway/package.json apps/gateway/package.json
COPY apps/desktop/package.json apps/desktop/package.json
COPY apps/mobile/package.json apps/mobile/package.json
RUN npm install --no-audit --no-fund
COPY packages/core packages/core
COPY apps/gateway apps/gateway
RUN npm --workspace apps/gateway run build

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    AIDB_HOME=/data \
    AIDB_HOST=0.0.0.0 \
    AIDB_PORT=8787
COPY --from=build /repo/apps/gateway/dist ./dist
# ssh2 is external (native optional bindings); ship its pure-JS dependencies.
COPY --from=build /repo/node_modules/ssh2 ./node_modules/ssh2
COPY --from=build /repo/node_modules/asn1 ./node_modules/asn1
COPY --from=build /repo/node_modules/safer-buffer ./node_modules/safer-buffer
COPY --from=build /repo/node_modules/bcrypt-pbkdf ./node_modules/bcrypt-pbkdf
COPY --from=build /repo/node_modules/tweetnacl ./node_modules/tweetnacl
VOLUME ["/data"]
EXPOSE 8787
CMD ["node", "dist/index.js"]
