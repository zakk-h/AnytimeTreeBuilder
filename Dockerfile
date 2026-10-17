
FROM node:22-bookworm AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    cmake g++ make \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . .

RUN BUILD_JOBS=1 bash ./build.sh

FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    libstdc++6 ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /app/bin/arborenum-builder ./bin/arborenum-builder
COPY --from=builder /app/InteractiveTreeBuilder/dist/index.html ./InteractiveTreeBuilder/dist/index.html

ENV PORT=10000
EXPOSE 10000

CMD ["sh", "-c", "exec ./bin/arborenum-builder --ui ./InteractiveTreeBuilder/dist/index.html --port \"${PORT:-10000}\""]
