# venice-e2ee-proxy container image.
#
# The source is cloned inside the builder instead of being copied from the
# build context. That is deliberate: `venice-e2ee` is a git submodule, and a
# context copy would only work when the person running the build had already
# checked it out. Cloning at VENICE_PROXY_REF makes the image self-contained
# and makes that ref the one thing that decides which code runs.
#
# Consequences, both visible in docker-compose.yml:
#   - the build context is unused (see .dockerignore);
#   - local working-tree changes are NOT in the image. Push the commit and
#     point VENICE_PROXY_REF at it.
#
#   docker build -t venice-e2ee-proxy .
#   docker build --build-arg VENICE_PROXY_REF=<sha> -t venice-e2ee-proxy .
#
# Both stages use the same base image, pinned by digest: the floating tag would
# otherwise let the same Dockerfile produce different toolchains on different
# days. Bump the tag and the digest together.
FROM node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a AS builder

ARG VENICE_PROXY_REPO=https://github.com/jooray/venice-e2ee-proxy.git
# A commit, not a branch tip, so `docker compose build` is reproducible by
# default. scripts/update-venice-proxy-ref.sh rewrites this line together with
# the defaults in docker-compose.yml and .env.example.
ARG VENICE_PROXY_REF=4b5602ef6a4d18e5379d9d866fd375ba24cefd2f

WORKDIR /app

# `git` is pinned to the version in the pinned image's Alpine repository: a
# bare `apk add git` resolves against a live index, so the same Dockerfile
# could install a different git on a later build. Bump this with the digest.
RUN apk add --no-cache git=2.54.1-r0 \
  && git clone "${VENICE_PROXY_REPO}" /app \
  && git -C /app checkout "${VENICE_PROXY_REF}" \
  && git -C /app submodule update --init --recursive

RUN cd venice-e2ee && npm ci && npm run build
RUN npm ci && npm run build

FROM node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a AS runner

WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000

# Service listeners stay inside the container; the port is published on
# loopback by docker-compose.yml.
COPY --from=builder /app/package.json /app/package-lock.json ./
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/venice-e2ee/package.json /app/venice-e2ee/package-lock.json ./venice-e2ee/
COPY --from=builder /app/venice-e2ee/dist ./venice-e2ee/dist

RUN npm ci --omit=dev && npm cache clean --force

# `/app` is root-owned while the process runs as `node`, so VERIFY_RECEIPTS
# cannot write the default `.venice-receipt-anchors.json` in the working
# directory. Put the anchor store on a volume instead, and create the mount
# point owned by node so a fresh named volume inherits that ownership.
ENV RECEIPT_ANCHOR_STORE=/data/receipt-anchors.json
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
