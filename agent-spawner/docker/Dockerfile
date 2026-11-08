FROM ubuntu:24.04

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    git \
    curl \
    python3 \
    python3-pip \
    && curl -fsSL https://antigravity.google/cli/install.sh -o /tmp/install-agy.sh \
    && bash /tmp/install-agy.sh -d /usr/local/bin \
    && rm -f /tmp/install-agy.sh \
    && chmod 755 /usr/local/bin/agy \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace
