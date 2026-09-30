# BetterSync server. Build from the repo root:
#   docker build -t bettersync-server .
# Run (see deploy/docker-compose.yml): data in /data, plain HTTP on 8787,
# published on localhost only, with nginx terminating TLS in front.

FROM oven/bun:1.4 AS build
WORKDIR /src
COPY package.json bun.lock tsconfig.json ./
COPY packages ./packages
RUN bun install --frozen-lockfile
RUN bun build --compile --minify packages/server/src/cli.ts --outfile /out/bettersync

FROM debian:bookworm-slim
RUN useradd --system --uid 10001 --home-dir /data bettersync \
 && mkdir /data && chown bettersync:bettersync /data
COPY --from=build /out/bettersync /usr/local/bin/bettersync
USER bettersync
ENV BETTERSYNC_DATA=/data BETTERSYNC_HOST=0.0.0.0 BETTERSYNC_PORT=8787
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=6s CMD ["bettersync", "healthcheck"]
ENTRYPOINT ["bettersync"]
CMD ["serve"]
