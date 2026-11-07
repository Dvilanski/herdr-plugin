FROM ubuntu:24.04

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    git \
    curl \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

COPY agy /usr/local/bin/agy
RUN chmod 755 /usr/local/bin/agy

WORKDIR /workspace
