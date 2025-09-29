FROM ubuntu:24.04

WORKDIR /app

# Copy the repo
COPY . .

# Install deps including nodejs (for better compatibility)
RUN apt-get update && apt-get install -y \
    build-essential \
    python3 \
    nodejs \
    npm \
    libudev-dev \
    libusb-1.0-0-dev \
    curl \
    jq \
    sudo \
    unzip \
    git \
    && rm -rf /var/lib/apt/lists/*

# Install Bun
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:$PATH"

# Install Foundry
RUN curl -L https://foundry.paradigm.xyz | bash
ENV PATH="/root/.foundry/bin:$PATH"

RUN foundryup
RUN bun install --frozen-lockfile --production
RUN bun run typechain
RUN forge install

ENTRYPOINT ["bun", "run", "script/deploy/safe/execute-pending-timelock-tx.ts"]
