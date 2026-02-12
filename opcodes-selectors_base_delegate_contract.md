# Function selectors derived from opcodes.txt

Extracted from the contract’s dispatch logic: every `PUSH4 <8 hex digits>` that is not the sentinel `0xffffffff` or the `Error(string)` selector `0x4e487b71`.

Selectors are the first 4 bytes of `keccak256(canonical_signature)`. Signatures below for unknown selectors were resolved via the [4byte.directory](https://www.4byte.directory/) API where available.

## Decode via 4byte API

To refresh or resolve selectors yourself:

```bash
# Decode all selectors listed in this file (reads opcodes-selectors.md)
./script/tasks/decodeSelectors4byte.sh

# Decode specific selectors
./script/tasks/decodeSelectors4byte.sh 0x8388464e 0xac4c5fcc

# Read selectors from stdin (one 0x... per line)
grep -oE '0x[0-9a-f]{8}' opcodes-selectors.md | sort -u | ./script/tasks/decodeSelectors4byte.sh --stdin
```

Uses `GET https://www.4byte.directory/api/v1/signatures/?hex_signature=0x...`. Optional: `FOURBYTE_DELAY=0.5` to slow requests.

## Full list (50 selectors)

Contract: 0x36d3CBD83961868398d056EfBf50f5CE15528c0D (Base)

| Selector    | Signature (from 4byte or known) |
|------------|----------------------------------|
| `0x01ffc9a7` | `supportsInterface(bytes4)` (ERC165) |
| `0x0b135d3f` | — |
| `0x0db02622` | `ownerCount()` |
| `0x150b7a02` | `onERC721Received(address,address,uint256,bytes)` |
| `0x1626ba7e` | `isValidSignature(bytes32,bytes)` (ERC1271) |
| `0x18fb5864` | — |
| `0x19822f7c` | `validateUserOp((address,uint256,bytes,bytes,bytes32,uint256,bytes32,bytes,bytes),bytes32,uint256)` |
| `0x1f6dc437` | `isAdmin(uint256)` |
| `0x24359879` | `ownerAt(uint256)` |
| `0x28495877` | — |
| `0x295d6e87` | — |
| `0x3a4741bd` | `IMPLEMENTATION()` |
| `0x3e1b0812` | — |
| `0x3f707e6b` | `execute((address,uint256,bytes)[])` |
| `0x466e5483` | — |
| `0x4911df19` | — |
| `0x4f1ef286` | `upgradeToAndCall(address,bytes)` (UUPS) |
| `0x52d1902d` | `proxiableUUID()` |
| `0x55299b49` | `UpgradeFailed()` (event) |
| `0x57e191af` | — |
| `0x6575f6aa` | — |
| `0x7089813f` | — |
| `0x7613e7ba` | — |
| `0x7935e145` | — |
| `0x8388464e` | — |
| `0x84b0196e` | `eip712Domain()` |
| `0x850aaf62` | `delegateAndRevert(address,bytes)` |
| `0x8dd7712f` | `executeUserOp((address,uint256,bytes,bytes,bytes32,uint256,bytes32,bytes,bytes),bytes32)` |
| `0x9659291c` | — |
| `0x9b2c81d3` | — |
| `0x9f03a026` | — |
| `0x9fde78ae` | — |
| `0xa05b775f` | `getExpiration(uint256)` |
| `0xa05bd44e` | — |
| `0xa85a325c` | — |
| `0xac4c5fcc` | — |
| `0xae7dbde1` | — |
| `0xaffbb225` | — |
| `0xb0d691fe` | `entryPoint()` |
| `0xb4765db7` | `transferFromToken(address,address,uint256)` |
| `0xbc197c81` | `onERC1155BatchReceived(address,address,uint256[],uint256[],bytes)` |
| `0xd243719d` | — |
| `0xda2f8895` | — |
| `0xe7449fcd` | — |
| `0xea7ee010` | `getTokenAllowance(address,address)` |
| `0xf23a6e61` | `onERC1155Received(address,address,uint256,uint256,bytes)` |
| `0xf5a267f1` | — |
| `0xfca7a691` | — |
| `0xfccc3146` | — |
| `0xfdfdca0f` | — |

## Excluded

- **`0xffffffff`** – Used as sentinel/mask in the bytecode (not a function selector).
- **`0x4e487b71`** – `Panic(uint256)`; used for revert encoding, not dispatch. (4byte also lists as `Panic(uint256)`; for `Error(string)` the selector is `0x08c379a0`.)

## EIP-712 constants derived from opcodes

For the Base delegator (ERC-1271 / `isValidSignature`), these **PUSH32** values were identified in `opcodes.txt`:

| Constant | PUSH32 value | Meaning |
|----------|--------------|---------|
| EIP712 domain typehash | `8b73c3c69bb8fe3d512ecc4cf759cc79239f7b179b0ffacaa9a75d522b39400f` | `keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")` |
| Name hash | `a4e964af7e98ecfc5bdbce722e558c4b02d7960de9e1f014f3cd6a6bf7a86fde` | `keccak256("SmartWallet")` |
| Version hash | `06c015bd22b4c69690933c1058878ebdfef31f9aaae40bbe86d8a09fe1b2972c` | `keccak256("1.0.0")` |
| Message struct type hash | `91ab3d17e3a50a9d89e63fd30b92be7f5336b03b287bb946787a83a9d62a2766` | Used in EIP-712 hash build block; **exact type string unknown** (e.g. `Message(bytes32 hash)` does not match). |

The domain can be obtained at runtime via `eip712Domain()` (selector `0x84b0196e`). The message struct type used for ERC-1271 is not exposed by any standard function; get it from the implementation (docs or decompilation).

## Resolving unknown selectors

- Run `./script/tasks/decodeSelectors4byte.sh` to query 4byte for all selectors.
- Or use [4byte.directory](https://www.4byte.directory/) in the browser, or Foundry: `cast sig "owner()"`.
