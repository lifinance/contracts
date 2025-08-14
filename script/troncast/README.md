# TronCast CLI Tool

TronCast is a Cast-like CLI tool for interacting with Tron blockchain smart contracts. It provides a simple interface for reading contract data and sending transactions.

## Why TronCast?

This tool was created because Foundry's Forge and Cast don't natively support the Tron network. While Cast is an excellent tool for Ethereum and EVM-compatible chains, Tron's unique architecture and address format require specialized tooling. TronCast bridges this gap by providing familiar Cast-like commands specifically designed for Tron development, allowing developers to:

- Interact with Tron smart contracts using familiar command-line patterns
- Read contract state and send transactions without writing custom scripts
- Maintain consistency with existing Foundry-based workflows while working on Tron

## Installation

The tool is already integrated into the project. No additional installation is required.

## Usage

### Basic Commands

```bash
# Show help
bun troncast --help

# Show help for a specific command
bun troncast call --help
bun troncast send --help
```

### Call Command (Read-Only)

Execute read-only contract calls without sending transactions.

```bash
# Basic call
bun troncast call <address> "<function_signature>" [params...] [options]

# Examples
bun troncast call <TOKEN_ADDRESS> "name() returns (string)" --env mainnet
bun troncast call <TOKEN_ADDRESS> "symbol() returns (string)" --env mainnet
bun troncast call <TOKEN_ADDRESS> "decimals() returns (uint8)" --env mainnet
bun troncast call <TOKEN_ADDRESS> "balanceOf(address) returns (uint256)" <WALLET_ADDRESS> --env mainnet

# With JSON output
bun troncast call <TOKEN_ADDRESS> "decimals() returns (uint8)" --env mainnet --json
```

### Send Command (Transactions)

Send transactions to modify contract state.

```bash
# Basic send
bun troncast send <address> "<function_signature>" [params...] [options]

# Examples
# Transfer tokens (requires private key)
bun troncast send <TOKEN_ADDRESS> "transfer(address,uint256)" <RECEIVER_ADDRESS>,1000000 --private-key YOUR_KEY

# Approve spending (dry run)
bun troncast send <TOKEN_ADDRESS> "approve(address,uint256)" <SPENDER_ADDRESS>,1000000 --dry-run

# Send with TRX value
bun troncast send <CONTRACT_ADDRESS> "deposit()" --value 0.1tron --private-key YOUR_KEY
```

### Options

#### Call Command Options

- `--env` - Environment: "mainnet" or "testnet" (default: mainnet)
- `--block` - Block number for historical queries
- `--json` - Output result as JSON

#### Send Command Options

- `--env` - Environment: "mainnet" or "testnet" (default: mainnet)
- `--private-key` - Private key for signing (or from environment)
- `--value` - TRX value to send (e.g., "0.1tron", "100000sun")
- `--fee-limit` - Maximum fee in TRX (default: 1000)
- `--energy-limit` - Energy limit
- `--no-confirm` - Don't wait for confirmation
- `--dry-run` - Simulate without sending
- `--json` - Output result as JSON

## Network Configuration

The tool retrieves RPC URLs from `config/networks.json`. If not found there, it falls back to hardcoded defaults:

- **Mainnet**: https://api.trongrid.io (from networks.json or default)
- **Testnet**: https://api.shasta.trongrid.io (from networks.json or default)

## Function Signature Format

Function signatures follow the Solidity/Foundry format:

```
functionName(param1Type,param2Type) returns (returnType)
```

Examples:

- `balanceOf(address) returns (uint256)`
- `transfer(address,uint256) returns (bool)`
- `name() returns (string)`
- `getReserves() returns (uint112,uint112,uint32)`

## Value Formats

TRX values can be specified in different formats:

- `0.1tron` - 0.1 TRX (automatically converted to SUN)
- `100000sun` - 100000 SUN
- `100000` - Raw SUN value

## Known Limitations

### Compatibility Issues

Due to a compatibility issue between TronWeb and Bun, you may occasionally see a "proto is not defined" error. Simply retry the command and it should work.

### Feature Limitations

The following Cast features are not yet supported in TronCast:

- **ABI fetching**: Cannot automatically fetch contract ABIs from block explorers
- **Contract verification**: No support for verifying contracts on TronScan
- **Wallet management**: No built-in wallet creation/management features
- **Advanced gas estimation**: Limited gas estimation compared to Cast
- **Chain forking**: No support for forking Tron networks for testing
- **Scripting**: No support for complex scripting like Cast scripts
- **ENS/TNS resolution**: No name service resolution support
- **Event filtering**: Limited event log querying capabilities

These limitations are due to fundamental differences between Tron and Ethereum ecosystems, as well as the current scope of the tool being focused on basic contract interaction needs.

## Examples

### Check Token Information

```bash
# Get token info on mainnet
bun troncast call <TOKEN_ADDRESS> "name() returns (string)" --env mainnet
bun troncast call <TOKEN_ADDRESS> "symbol() returns (string)" --env mainnet
bun troncast call <TOKEN_ADDRESS> "decimals() returns (uint8)" --env mainnet
```

### Check Balance

```bash
bun troncast call <TOKEN_ADDRESS> "balanceOf(address) returns (uint256)" <WALLET_ADDRESS> --env mainnet
```

### Dry Run Transaction

```bash
bun troncast send <TOKEN_ADDRESS> "transfer(address,uint256)" <RECEIVER_ADDRESS>,1000000 --dry-run
```

## Private Key Management

The private key can be provided in two ways:

1. Via command line: `--private-key YOUR_KEY`
2. Via environment variable (uses the existing `getPrivateKey()` function from the project)

**Security Note**: Be careful when using private keys on the command line as they may be visible in shell history.
