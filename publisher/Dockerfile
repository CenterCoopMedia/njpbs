FROM node:22-bookworm-slim@sha256:a6385bc33f0f9d6a08482c87f52baee537a9184e2b47dea1ed97caac62f8960c
RUN apt-get update && apt-get install -y --no-install-recommends bubblewrap ca-certificates git \
    && rm -rf /var/lib/apt/lists/* \
    && ln -s /usr/local/bin/node /usr/bin/node \
    && install -d -o node -g node /app \
    && install -d -m 700 -o node -g node /var/lib/njpbs-cms-publisher
WORKDIR /app
COPY --chown=node:node source/package.json source/package-lock.json /app/
COPY --chown=node:node source/functions/package.json /app/functions/
COPY --chown=node:node source/admin/package.json /app/admin/
COPY --chown=node:node source/cms-api/package.json /app/cms-api/
COPY --chown=node:node source/site/package.json source/site/package-lock.json /app/site/
USER node
# Containers use CPU inference; optional GPU downloads are not runtime inputs.
RUN export ONNXRUNTIME_NODE_INSTALL=skip \
    && npm ci --workspace=functions --include-workspace-root --omit=dev --no-audit --no-fund \
    && npm --prefix site ci --no-audit --no-fund \
    && npm cache clean --force
COPY --chown=node:node source/ /app/
RUN node --import /app/site/node_modules/tsx/dist/loader.mjs /app/site/scripts/prepare-search-model.ts \
    && mkdir -p site/dist site/.astro site/node_modules/.astro site/node_modules/.vite site/node_modules/.vite-temp
ENV NODE_ENV=production ASTRO_TELEMETRY_DISABLED=1 TZ=America/New_York
EXPOSE 8080
CMD ["/usr/bin/node", "--import", "/app/site/node_modules/tsx/dist/loader.mjs", "/app/site/scripts/run-cms-publication-cloud.ts", "--serve"]
