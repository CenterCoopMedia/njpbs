FROM node:22.23.5-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee
RUN apt-get update && apt-get install -y --no-install-recommends bubblewrap ca-certificates git \
    && rm -rf /var/lib/apt/lists/* \
    && ln -s /usr/local/bin/node /usr/bin/node \
    && install -d -o node -g node /app \
    && install -d -m 700 -o node -g node /var/lib/njpbs-cms-preview
WORKDIR /app
COPY --chown=node:node source/package.json source/package-lock.json /app/
COPY --chown=node:node source/functions/package.json /app/functions/
COPY --chown=node:node source/admin/package.json /app/admin/
COPY --chown=node:node source/cms-api/package.json /app/cms-api/
COPY --chown=node:node source/site/package.json source/site/package-lock.json /app/site/
USER node
# Containers use CPU inference; optional GPU downloads are not runtime inputs.
RUN export ONNXRUNTIME_NODE_INSTALL=skip \
    && npm ci --ignore-scripts --workspace=functions --omit=dev --no-audit --no-fund \
    && npm --prefix site ci --ignore-scripts --omit=dev --no-audit --no-fund \
    && npm cache clean --force
COPY --chown=node:node source/ /app/
RUN node /app/site/scripts/prepare-public-fonts.mjs \
    && node --import /app/site/node_modules/tsx/dist/loader.mjs /app/site/scripts/build-compiled-renderer.ts \
    && mkdir -p site/.astro site/node_modules/.astro site/node_modules/.vite
ENV NODE_ENV=production ASTRO_TELEMETRY_DISABLED=1 TZ=America/New_York
EXPOSE 8080
CMD ["/usr/bin/node", "--experimental-strip-types", "/app/site/scripts/run-cms-preview-cloud.ts", "--serve"]
