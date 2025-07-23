FROM ubuntu:24.04

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y \
    build-essential \
    python3 \
    libudev-dev \
    libusb-1.0-0-dev \
    curl \
    unzip \
    git \
    && rm -rf /var/lib/apt/lists/*

# Install Bun
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:$PATH"

# Install Foundry
RUN curl -L https://foundry.paradigm.xyz | bash
ENV PATH="/root/.foundry/bin:$PATH"
RUN /root/.foundry/bin/foundryup

# Copy package files first
COPY package.json bun.lock ./

# Install dependencies without problematic postinstall scripts
RUN bun install --frozen-lockfile --ignore-scripts
# RUN bun install

# Copy the entire project structure
COPY . .

# Try to manually install just tsx if needed for the abi script
RUN bun add tsx --dev

RUN forge clean && rm -rf typechain/* && forge build src && typechain --target ethers-v5 'out/*.sol/*.json' --out-dir typechain

ENTRYPOINT ["bun", "run", "script/deploy/safe/execute-pending-timelock-tx.ts"]
