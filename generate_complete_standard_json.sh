#!/bin/bash
# Generate complete standard JSON input with all dependencies for GasZipPeriphery.sol

CONTRACT="src/Periphery/GasZipPeriphery.sol"
OUTPUT="GasZipPeriphery_standard_json_complete.json"

echo "Flattening contract to get all dependencies..."
FLATTENED=$(forge flatten "$CONTRACT" 2>/dev/null)

if [ $? -ne 0 ]; then
    echo "Error: Failed to flatten contract"
    exit 1
fi

# Extract all unique source file paths from flattened output
# This is a simplified approach - in practice, you'd parse the flattened output more carefully
echo "Generating standard JSON input..."

# For now, create a version that includes the flattened content as a single source
# This is what most verification tools expect
jq -n \
  --arg content "$FLATTENED" \
  '{
    "language": "Solidity",
    "sources": {
      "src/Periphery/GasZipPeriphery.sol": {
        "content": $content
      }
    },
    "settings": {
      "remappings": [
        "lifi/=src/",
        "solady/=lib/solady/src/",
        "@openzeppelin/=lib/openzeppelin-contracts/",
        "solmate/=lib/solmate/src/",
        "permit2/=lib/Permit2/src/",
        "forge-std/=lib/forge-std/src/",
        "test/=test/"
      ],
      "optimizer": {
        "enabled": true,
        "runs": 1000000
      },
      "evmVersion": "cancun",
      "viaIR": false,
      "outputSelection": {
        "*": {
          "*": [
            "abi",
            "evm.bytecode",
            "evm.deployedBytecode",
            "evm.bytecode.sourceMap",
            "evm.deployedBytecode.sourceMap",
            "metadata"
          ],
          "": ["ast"]
        }
      }
    }
  }' > "$OUTPUT"

echo "Generated complete standard JSON input: $OUTPUT"
echo "Note: This includes all dependencies from the flattened contract."
