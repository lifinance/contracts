## **Part I: Architectural Decision**

## **1. Core Architecture Comparison**

### **1.1 High-Level Architecture**

| **Pattern** | **OLD Monolithic** | **NEW Diamond + Registry** |
| --- | --- | --- |
| **Proxy Style** | Transparent proxy. One huge contract | EIP-2535 Diamond. Minimal proxy + many facets |
| **Code-Size** | All logic in one file → size limits | Each facet separate → no init-code size hits |
| **Upgrade Scope** | Redeploy entire contract | Upgrade individual facet |
| **Modularity** | One `swap(...)` with 10+ branches | One facet per dex + dynamic registry dispatch |
| **Tests** | One massive suite | Per-facet suites (`CoreRouteFacet`, `FooFacet`) |
| **Callback Guards** | `lastCalledPool = ...` | `CallbackManager.arm()/verify()/clear()` (see 4.1) |
| **Transfers** | `IERC20(tokenIn).safeTransfer(msg.sender, uint256(amount));` | // In facet implementations: `import { LibAsset } from "../Libraries/LibAsset.sol"; LibAsset.transferAsset(tokenIn, payable(recipient), amount); LibAsset.transferFromERC20(tokenIn, from, recipient, amount); LibAsset.depositAsset(tokenIn, amount); |

---

### **1.2. Facet Breakdown & Naming**

The entry point remains exactly the same: users still call `processRoute(...)`, but under the new architecture that logic now lives in **CoreRouteFacet.sol**, which looks up the target in the registry and forwards execution to the appropriate dex facet. All DEX-related facets will follow the naming convention: **`{DexName}Facet.sol`**.

| **OLD (standalone functions)** | **NEW Facet** | **Notes** |
| --- | --- | --- |
| `processRoute(...)`, `transferValueAnd…(...)` | **CoreRouteFacet.sol** | Entrypoints + registry + helpers (`applyPermit`, `distributeAndSwap`, `dispatchSwap`) |
| `swapUniV2(...)` | **UniswapV2StyleFacet.sol** | Handles UniV2, SushiSwap, PancakeV2, TraderJoe V1, and other router-based DEXs |
| `swapUniV3(...)` + `uniswapV3SwapCallback(...)` | **UniV3Facet.sol** | Uniswap V3 logic and callbacks |
| `pancakeV3SwapCallback(...)` | **PancakeV3Facet.sol** | May or may not include swap function depending on approach (see sections 3.1 and 3.2) |

## **3. Two New Architectural Approaches**

This document presents **two approaches** to replace the monolithic if/else dispatch system from the original `LiFiDEXAggregator.sol`. Both approaches leverage the Diamond pattern to overcome contract size limitations and provide extensibility.

**Context**: The original monolithic design required `poolTypes` because in this way we could reduce contract size limit and gas costs. With the Diamond pattern, we can explore better architectures that prioritize user gas costs and deployment simplicity.

### **3.1 Approach 1: Registry driven dispatch**

This approach uses a dynamic registry where DEX types (previously named as `poolTypes`) are registered with their corresponding function selectors, enabling runtime dispatch without hardcoded if/else chains.

### **OLD (LiFiDEXAggregator.sol monolithic if/else):**

```solidity
uint8 t = stream.readUint8();
if (t == POOL_TYPE_UNIV2)      swapUniV2(...);
else if (t == POOL_TYPE_UNIV3) swapUniV3(...);
else if (t == POOL_TYPE_VELODROME_V2) swapVelodromeV2(...);
else if (t == POOL_TYPE_ALGEBRA) swapAlgebra(...);
// ... 20+ more else-if statements
// Growing chain = increasing gas costs

```

### **NEW (Registry driven dispatch):**

```solidity
// DRAFT code of CoreRouteFacet contract
// DRAFT code of CoreRouteFacet contract
// DRAFT code of CoreRouteFacet contract

// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { LibDiamond } from "../Libraries/LibDiamond.sol";
import { LibAccess } from "../Libraries/LibAccess.sol";
import { EnumerableSet } from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

/// --- Custom Errors --- ///
error UnknownDexType();
error SwapFailed();
error DexTypeAlreadyRegistered();
error CannotRemoveUnknownDexType();
error MismatchedArrayLength();

/// @title CoreRouteFacet
/// @notice Handles DEX type registration and swap dispatching via selector registry
contract CoreRouteFacet {
    using EnumerableSet for EnumerableSet.UintSet;

    /// --- Storage Namespace --- ///
    bytes32 internal constant NAMESPACE = keccak256("com.lifi.lda.facets.core.route");

    struct Storage {
        mapping(uint8 => bytes4) swapSelectorByDex;
        mapping(bytes4 => uint8) dexTypeBySelector;
        EnumerableSet.UintSet dexTypes;
    }

    function getStorage() internal pure returns (Storage storage s) {
        bytes32 namespace = NAMESPACE;
        assembly {
            s.slot := namespace
        }
    }

    /// --- Events --- ///
    event DexTypeRegistered(uint8 indexed dexType, bytes4 indexed selector);
    event DexTypeRemoved(uint8 indexed dexType);

    /// --- Admin Functions --- ///

    function registerDexType(uint8 dexType, bytes4 selector) external {
        if (msg.sender != LibDiamond.contractOwner()) {
            LibAccess.enforceAccessControl();
        }

        Storage storage s = getStorage();
        if (s.dexTypes.contains(dexType)) revert DexTypeAlreadyRegistered();

        s.swapSelectorByDex[dexType] = selector;
        s.dexTypeBySelector[selector] = dexType;
        s.dexTypes.add(dexType);

        emit DexTypeRegistered(dexType, selector);
    }

    function batchRegisterDexTypes(
        uint8[] calldata dexTypes_,
        bytes4[] calldata selectors
    ) external {
        if (msg.sender != LibDiamond.contractOwner()) {
            LibAccess.enforceAccessControl();
        }

        if (dexTypes_.length != selectors.length) {
            revert MismatchedArrayLength();
        }

        Storage storage s = getStorage();

        for (uint256 i = 0; i < dexTypes_.length; ) {
            uint8 dexType = dexTypes_[i];
            bytes4 selector = selectors[i];
            s.swapSelectorByDex[dexType] = selector;
            s.dexTypeBySelector[selector] = dexType;
            s.dexTypes.add(dexType);
            emit DexTypeRegistered(dexType, selector);
            unchecked {
                ++i;
            }
        }
    }

    function removeDexType(uint8 dexType) external {
        if (msg.sender != LibDiamond.contractOwner()) {
            LibAccess.enforceAccessControl();
        }

        Storage storage s = getStorage();
        bytes4 selector = s.swapSelectorByDex[dexType];
        if (selector == bytes4(0)) revert CannotRemoveUnknownDexType();

        delete s.swapSelectorByDex[dexType];
        delete s.dexTypeBySelector[selector];
        s.dexTypes.remove(dexType);

        emit DexTypeRemoved(dexType);
    }

    function batchRemoveDexTypes(uint8[] calldata dexTypes_) external {
        if (msg.sender != LibDiamond.contractOwner()) {
            LibAccess.enforceAccessControl();
        }

        Storage storage s = getStorage();

        for (uint256 i = 0; i < dexTypes_.length; ) {
            uint8 dexType = dexTypes_[i];
            bytes4 selector = s.swapSelectorByDex[dexType];
            if (selector != bytes4(0)) {
                delete s.swapSelectorByDex[dexType];
                delete s.dexTypeBySelector[selector];
                s.dexTypes.remove(dexType);
                emit DexTypeRemoved(dexType);
            }
            unchecked {
                ++i;
            }
        }
    }

    /// --- Internal Logic --- ///

    function dispatchSwap(
        uint8 dexType,
        uint256 stream,
        address from,
        address tokenIn,
        uint256 amountIn
    ) internal returns (uint256 amountOut) {
        Storage storage s = getStorage();
        bytes4 sel = s.swapSelectorByDex[dexType];
        if (sel == 0) revert UnknownDexType();

        bytes memory data = abi.encodePacked(sel, stream, from, tokenIn, amountIn);
        (bool ok, bytes memory ret) = address(this).delegatecall(data);
        if (!ok) revert SwapFailed();

        return abi.decode(ret, (uint256));
    }

    /// --- View Functions --- ///

    function getSwapSelectorByDex(uint8 dexType) external view returns (bytes4) {
        return getStorage().swapSelectorByDex[dexType];
    }

    function getDexTypeBySelector(bytes4 selector) external view returns (uint8) {
        return getStorage().dexTypeBySelector[selector];
    }

    function getAllDexTypes() external view returns (uint8[] memory result) {
        Storage storage s = getStorage();
        uint256 len = s.dexTypes.length();
        result = new uint8[](len);
        for (uint256 i = 0; i < len; ++i) {
            result[i] = uint8(s.dexTypes.at(i));
        }
    }

    function getAllDexTypesWithSelectors()
        external
        view
        returns (uint8[] memory dexTypesOut, bytes4[] memory selectors)
    {
        Storage storage s = getStorage();
        uint256 len = s.dexTypes.length();
        dexTypesOut = new uint8[](len);
        selectors = new bytes4[](len);

        for (uint256 i = 0; i < len; ++i) {
            uint8 dexType = uint8(s.dexTypes.at(i));
            dexTypesOut[i] = dexType;
            selectors[i] = s.swapSelectorByDex[dexType];
        }
    }
}

```

### **Adding New DEX (Approach 1):**

```solidity
// 1. Deploy FooFacet
// 2. Add diamondCut with FooFacet
// 3. Register new DEX type (optionally)
await coreRouteFacet.registerDexType(DEX_TYPE_FOO, FooFacet.swapFoo.selector);

```

### **NO Backend Changes (Approach 1):**

poolType (newly named dexTypes) stays the same like for the old version of LDA

---

### **3.2 Approach 2: Selector based dispatch**

This approach eliminates the registry entirely by having the backend directly specify function selectors in the route data, achieving the lowest possible gas costs and deployment complexity

### **OLD (LiFiDEXAggregator.sol monolithic if/else):**

```solidity
uint8 t = stream.readUint8();
if (t == POOL_TYPE_UNIV2)      swapUniV2(...);
else if (t == POOL_TYPE_UNIV3) swapUniV3(...);
else if (t == POOL_TYPE_VELODROME_V2) swapVelodromeV2(...);
else if (t == POOL_TYPE_ALGEBRA) swapAlgebra(...);
// ... 20+ more else-if statements
// Growing chain = increasing gas costs

```

### **NEW (Selector based dispatch):**

```solidity
function swap(
    uint256 stream,
    address from,
    address tokenIn,
    uint256 amountIn
) private {
    bytes4 selector = stream.readBytes4();

    (bool success, bytes memory result) = address(this).call(
        abi.encodePacked(selector, stream, from, tokenIn, amountIn)
    );
    if (!success) revert SwapFailed();
}

```

### **Adding New DEX (Approach 2):**

```solidity
// 1. Deploy FooFacet
// 2. Add diamondCut with FooFacet

```

### **Backend Changes (Approach 2):**

```tsx
// OLD route encoding
const routeData = encodeRoute({
  command: ProcessUserERC20,
  token: tokenIn,
  pools: [{
    poolType: POOL_TYPE_UNIV3,
    poolAddress: poolAddress,
    direction: direction,
    recipient: recipient
  }]
});

// NEW route encoding
const routeData = encodeRoute({
  command: ProcessUserERC20,
  token: tokenIn,
  pools: [{
    selector: UniV3Facet.swapUniV3.selector, // <== selector instead of poolType
    poolAddress: poolAddress,
    direction: direction,
    recipient: recipient
  }]
});

```

---

## **4. Implementation Details**

### **4.1 Facet Dependencies: Different for Each Approach**

### **Approach 1 (Registry): Dependencies Exist**

With the registry approach, compatible DEXs share the same `dexType` (previously `poolType`), creating dependencies:

```solidity
// UniV3Facet.sol - Main implementation
contract UniV3Facet {
    function swapUniV3(...) external returns (uint256) {
        // Full UniV3 swap logic implementation
    }

    function uniswapV3SwapCallback(...) external {
        // UniswapV3-specific callback logic
    }
}

// PancakeV3Facet.sol - Callback-only (DEPENDS on UniV3Facet)
contract PancakeV3Facet {
    // NO swapPancakeV3 function - reuses UniV3Facet.swapUniV3()

    function pancakeV3SwapCallback(...) external {
        // Forward to UniV3 callback logic
        IUniV3Facet(address(this)).uniswapV3SwapCallback(
            amount0Delta,
            amount1Delta,
            data
        );
    }
}

```

**Registry Approach Dependencies:**

- `PancakeV3Facet` **depends on** `UniV3Facet`
- Both use same `DEX_TYPE_UNIV3` dexType
- Deployment order matters: `UniV3Facet` must be deployed first
- PancakeV3 only provides callback wrapper

**Adding PancakeV3 (Registry Approach):**

```bash
# 1. Deploy UniV3Facet first (if not already deployed)
# 2. Register: registerDexType(DEX_TYPE_UNIV3, UniV3Facet.swapUniV3.selector)
# 3. Deploy PancakeV3Facet (callback only)
# 4. Add PancakeV3Facet to diamond (for callback)
# Backend uses DEX_TYPE_UNIV3 for both UniV3 and PancakeV3

```

---

### **Approach 2 (Selector): Zero Dependencies**

With the selector approach, each DEX has its own selector, enabling complete independence:

```solidity
// UniV3Facet.sol - Complete implementation
contract UniV3Facet {
    function swapUniV3(...) external returns (uint256) {
        // Full UniV3 swap logic implementation
    }

    function uniswapV3SwapCallback(...) external {
        // UniswapV3-specific callback logic
    }
}

// PancakeV3Facet.sol - Complete implementation (INDEPENDENT)
contract PancakeV3Facet {
    function swapPancakeV3(...) external returns (uint256) {
        // Full swap logic (can reuse UniV3 logic via libraries)
        return LibUniV3Logic.executeSwap(...);
    }

    function pancakeV3SwapCallback(...) external {
        // PancakeV3-specific callback logic
    }
}

```

**Selector Approach Dependencies:**

- **Zero dependencies** between facets
- Each facet is completely self-contained
- Deploy in any order
- **Compatible DEXs can share selectors** (e.g., UniV2 forks share `UniswapV2StyleFacet.swapUniV2.selector`)

**Adding PancakeV3 (Selector Approach):**

```bash
# 1. Deploy PancakeV3Facet (complete implementation)
# 2. Add PancakeV3Facet to diamond
# Backend immediately uses PancakeV3Facet.swapPancakeV3.selector

```

---

## **5. Adding a New DEX**

### **5.1 Approach 1 (Registry): Onboarding Process**

### **For Uniswap V3-compatible forks (no new dexType needed):**

Many Uniswap V3 forks (eg Pancake V3) use exactly the Uniswap V3 swap signature but different callback semantics. You don't need a whole new facet or dexType. Only new smaller facet (without swap function) with callback forward:

```solidity
/// DRAFT file for PancakeV3Facet.sol
/// DRAFT file for PancakeV3Facet.sol
/// DRAFT file for PancakeV3Facet.sol

// interface with callback in seperated file
interface IUniV3Facet {
    function uniswapV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external;
}

// example for PancakeV3 facet
contract PancakeV3Facet {
    function pancakeV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external {
        // keep the same logic of handling callback from uniswap v3
        IUniV3Facet(address(this)).uniswapV3SwapCallback(
            amount0Delta,
            amount1Delta,
            data
        );
    }
}

```

**Steps:**

1. DiamondCut in `PancakeV3CallbackFacet.pancakeV3SwapCallback`.
2. No new dexType registration, since it reuses `DEX_TYPE_UNIV3`.

### **For completely new DEX (new dexType needed):**

```solidity
/// DRAFT file for FooFacet.sol
/// DRAFT file for FooFacet.sol
/// DRAFT file for FooFacet.sol

import { InputStream } from "./InputStream.sol";
import { CallbackManager } from "../Libraries/CallbackManager.sol";
interface IFooPool { /* … */ } // in seperated file

contract FooFacet {
    using CallbackManager for *;
    uint8 public constant DEX_TYPE = 4; // New dexType

    function swapFoo(
        uint256 stream,
        address from,
        address tokenIn,
        uint256 amountIn
    ) external returns (uint256 amountOut) {
        CallbackManager.arm(pool); // if pool does callback
        /// IFooPool(pool).swap ...
        CallbackManager.verify(); // if pool does callback
    }

    // callback implemented only if pool does callback
    function fooSwapCallback(bytes calldata data) external {
        // validate msg.sender==pool…
        CallbackManager.clear();
        // transfer funds…
    }
}

```

**Steps:**

1. DiamondCut in `FooFacet.swapFoo` and/or `fooSwapCallback`.
2. Register new type:
    
    ```
    await coreRouteFacet.registerDexType(DEX_TYPE_FOO, FooFacet.swapFoo.selector);
    
    ```
    

---

### **5.2 Approach 2 (Selector): Onboarding Process**

### **For Uniswap V3-compatible forks:**

Each V3 fork typically gets its own facet due to callback differences:

```solidity
/// DRAFT file for PancakeV3Facet.sol
/// DRAFT file for PancakeV3Facet.sol
/// DRAFT file for PancakeV3Facet.sol

contract PancakeV3Facet {
    function swapPancakeV3(
        uint256 stream,
        address from,
        address tokenIn,
        uint256 amountIn
    ) external returns (uint256 amountOut) {
        // Complete swap implementation (can reuse LibUniV3Logic)
        return LibUniV3Logic.executeSwap(...);
    }

    function pancakeV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external {
        // PancakeV3-specific callback logic
    }
}

```

**Steps:**

1. Deploy `PancakeV3Facet`
2. DiamondCut in `PancakeV3Facet.swapPancakeV3` and `pancakeV3SwapCallback`
3. Backend immediately uses `PancakeV3Facet.swapPancakeV3.selector`

### **For completely new DEX:**

```solidity
/// DRAFT file for FooFacet.sol
/// DRAFT file for FooFacet.sol
/// DRAFT file for FooFacet.sol

contract FooFacet {
    function swapFoo(
        uint256 stream,
        address from,
        address tokenIn,
        uint256 amountIn
    ) external returns (uint256 amountOut) {
        // Complete swap implementation
    }

    function fooSwapCallback(bytes calldata data) external {
        // Callback logic if needed
    }
}

```

**Steps:**

1. Deploy `FooFacet`
2. DiamondCut in `FooFacet.swapFoo` and/or `fooSwapCallback`
3. Backend immediately uses `FooFacet.swapFoo.selector`

### **5.3 Comparison: Adding PancakeV3**

| **Step** | **Approach 1 (Registry)** | **Approach 2 (Selector)** |
| --- | --- | --- |
| **1. Deploy** | Deploy callback-only facet | Deploy complete facet |
| **2. Registration** | No registration (reuses DEX_TYPE_UNIV3) | No registration needed |
| **3. Backend** | Uses existing DEX_TYPE_UNIV3 | Uses PancakeV3Facet.swapPancakeV3.selector |
| **4. Dependencies** | Requires UniV3Facet deployed first | Zero dependencies |
| **5. Code Reuse** | Interface call to UniV3Facet | Library-based code reuse |

---

## **6. Facet & Callback Dependencies**

### **6.1 Approach 1 (Registry): Dependencies Exist**

**Problem:** Some facets require other facets to already be cut & registered due to shared dex types.

**Example:** `PancakeV3Facet` requires `UniV3Facet` because:

- Both use `DEX_TYPE_UNIV3`
- PancakeV3 forwards calls to UniV3 swap function
- PancakeV3 only provides callback wrapper

**How to handle:**

- Track via `deps:` comment at the top of facet source file:
    
    ```solidity
    // deps: UniV3Facet
    contract PancakeV3Facet {
        // callback-only implementation
    }
    
    ```
    
- Add facet dependency validation to `DeployFacet.s.sol`
- Ensure dependency order in deployment scripts
- Document dependencies in deployment runbook

---

### **6.2 Approach 2 (Selector): Zero Dependencies**

**Benefit:** Each facet is completely self-contained with no dependencies.

**Example:** `PancakeV3Facet` is independent because:

- Has its own unique selector
- Contains complete swap implementation
- No shared state with other facets
- Can be deployed in any order

**How to handle:**

- No dependency tracking needed
- Deploy facets in any order
- Each facet includes complete implementation
- Use libraries for code reuse without dependencies

---

## **7. Testing, Deployment & Migration Workflow**

### **7.1 Approach 1: Registry based Testing**

### **Directory Structure**

```
test/solidity/Lda/
├── Facets/
│   ├── LdaTestBase.t.sol    # Registry specific base class
│   ├── CoreRouteFacet.t.sol         # Registry and dispatch tests
│   ├── FooFacet.t.sol               # Foo dex integration tests

```

### **LdaTestBase.t.sol**

```solidity
/// DRAFT file for LdaTestBase.t.sol
/// DRAFT file for LdaTestBase.t.sol
/// DRAFT file for LdaTestBase.t.sol

// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.17;

import { TestBase } from "../utils/TestBase.sol";
import { LdaDiamond } from "lifi/Lda/LdaDiamond.sol";
import { CoreRouteFacet } from "lifi/Lda/Facets/CoreRouteFacet.sol";
import { LibDiamond } from "lifi/Libraries/LibDiamond.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title LdaTestBase
 * @notice Abstract base test contract for LDA facet tests
 * @dev Provides Diamond setup
 */
abstract contract LdaTestBase is TestBase {
    // Core Diamond components
    LdaDiamond internal ldaDiamond;
    CoreRouteFacet internal coreRouteFacet;

    // Common events
    event Route(
        address indexed from,
        address to,
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOutMin,
        uint256 amountOut
    );

    // Common errors
    error UnknownDexType();
    error SwapFailed();
    error InvalidCallData();

    function setUp() public virtual {
        initTestBase();
        vm.label(USER_SENDER, "USER_SENDER");
        setupLdaDiamond();
    }

    function setupLdaDiamond() internal {
        ldaDiamond = new LdaDiamond(USER_DIAMOND_OWNER);
        coreRouteFacet = new CoreRouteFacet();

        // Add CoreRouteFacet with registry functions
        LibDiamond.FacetCut[] memory cut = new LibDiamond.FacetCut[](1);
        bytes4[] memory selectors = new bytes4[](8);
        selectors[0] = CoreRouteFacet.processRoute.selector;
        selectors[1] = CoreRouteFacet.registerDexType.selector;
        selectors[2] = CoreRouteFacet.removeDexType.selector;
        selectors[3] = CoreRouteFacet.batchRegisterDexTypes.selector;
        selectors[4] = CoreRouteFacet.batchRemoveDexTypes.selector;
        selectors[5] = CoreRouteFacet.getSwapSelectorByDex.selector;
        selectors[6] = CoreRouteFacet.getDexTypeBySelector.selector;
        selectors[7] = CoreRouteFacet.getAllDexTypes.selector;

        cut[0] = LibDiamond.FacetCut({
            facetAddress: address(coreRouteFacet),
            action: LibDiamond.FacetCutAction.Add,
            functionSelectors: selectors
        });

        vm.prank(USER_DIAMOND_OWNER);
        LibDiamond.diamondCut(cut, address(0), "");

        coreRouteFacet = CoreRouteFacet(address(ldaDiamond));
        vm.label(address(ldaDiamond), "LdaDiamond");
        vm.label(address(coreRouteFacet), "CoreRouteFacet");
    }

    function addFacetAndRegister(
        address facetAddress,
        bytes4 swapSelector,
        uint8 dexType
    ) internal {
        // Add facet to Diamond
        LibDiamond.FacetCut[] memory cut = new LibDiamond.FacetCut[](1);
        bytes4[] memory selectors = new bytes4[](1);
        selectors[0] = swapSelector;

        cut[0] = LibDiamond.FacetCut({
            facetAddress: facetAddress,
            action: LibDiamond.FacetCutAction.Add,
            functionSelectors: selectors
        });

        vm.prank(USER_DIAMOND_OWNER);
        LibDiamond.diamondCut(cut, address(0), "");

        // Register dexType
        vm.prank(USER_DIAMOND_OWNER);
        coreRouteFacet.registerDexType(dexType, swapSelector);
    }

    function buildRoute(
        address tokenIn,
        uint256 amountIn,
        uint8 dexType,
        bytes memory poolData
    ) internal pure returns (bytes memory) {
        return abi.encodePacked(
            uint8(2), // processUserERC20
            tokenIn,
            uint8(1), // number of pools
            uint16(65535), // full share
            dexType,
            poolData
        );
    }

    // Abstract test functions
    function test_CanSwap() public virtual;
    function test_CanSwap_FromDiamond() public virtual;
    function test_CanSwap_MultiHop() public virtual;
    function test_FieldValidation() public virtual;

    // DEX type constants
    uint8 internal constant DEX_TYPE_UNIV2 = 0;
    uint8 internal constant DEX_TYPE_UNIV3 = 1;
    uint8 internal constant DEX_TYPE_VELODROME_V2 = 6;
    uint8 internal constant DEX_TYPE_ALGEBRA = 7;
    uint8 internal constant DEX_TYPE_IZUMI_V3 = 8;
    uint8 internal constant DEX_TYPE_SYNCSWAP = 9;
}

```

### **Example FooFacet.t.sol**

```solidity
/// DRAFT file for FooFacet.t.sol
/// DRAFT file for FooFacet.t.sol
/// DRAFT file for FooFacet.t.sol

contract FooFacetTest is LdaTestBase {
    FooFacet internal fooFacet;
    uint8 internal constant DEX_TYPE_FOO = 10;

    function setUp() public override {
        super.setUp();
        fooFacet = new FooFacet();
        addFacetAndRegister(address(fooFacet), fooFacet.swapFoo.selector, DEX_TYPE_FOO);
    }

    function test_CanSwap() public override {
        bytes memory route = buildRoute(
            address(tokenA),
            1000e18,
            DEX_TYPE_FOO,
            abi.encodePacked(address(pool), uint8(1), address(USER_RECEIVER))
        );

        vm.prank(USER_SENDER);
        uint256 amountOut = coreRouteFacet.processRoute(
            address(tokenA), 1000e18, address(tokenB), 950e18, USER_RECEIVER, route
        );

        assertGt(amountOut, 950e18);
    }

    function test_CanSwap_FromDiamond() public override {
        // TODO:
    }

    function test_CanSwap_MultiHop() public override {
        // TODO:
    }

    function test_FieldValidation() public override {
        // TODO:
    }
}

```

### **Deployment Scripts**

- `script/deploy/lda/facets/DeployXFacet.s.sol`
- `scriptMaster.sh` — calls `registerDexType(...)` after facet deployment

### **Migration Path**

- `script/lda/migrateDexTypes.ts` — registry migration

---

### **7.2 Approach 2: Selector based Testing**

### **Directory Structure**

```
test/solidity/Lda/
├── Facets/
│   ├── LdaTestBase.t.sol    # Selector specific base class
│   ├── CoreRouteFacet.t.sol         # Basic routing tests
│   ├── FooFacet.t.sol               # Foo dex integration tests

```

### **LdaTestBase.t.sol**

```solidity
/// DRAFT file for LdaTestBase.t.sol
/// DRAFT file for LdaTestBase.t.sol
/// DRAFT file for LdaTestBase.t.sol

// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.17;

import { TestBase } from "../utils/TestBase.sol";
import { LdaDiamond } from "lifi/Lda/LdaDiamond.sol";
import { CoreRouteFacet } from "lifi/Lda/Facets/CoreRouteFacet.sol";
import { LibDiamond } from "lifi/Libraries/LibDiamond.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title LdaTestBase
 * @notice Abstract base test contract
 * @dev Provides Diamond setup
 */
abstract contract LdaTestBase is TestBase {
    // Core Diamond components
    LdaDiamond internal ldaDiamond;
    CoreRouteFacet internal coreRouteFacet;

    // Common events
    event Route(
        address indexed from,
        address to,
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOutMin,
        uint256 amountOut
    );

    // Common errors
    error SwapFailed();
    error InvalidCallData();

    function setUp() public virtual {
        initTestBase();
        vm.label(USER_SENDER, "USER_SENDER");
        setupLdaDiamond();
    }

    function setupLdaDiamond() internal {
        ldaDiamond = new LdaDiamond(USER_DIAMOND_OWNER);
        coreRouteFacet = new CoreRouteFacet();

        // Add CoreRouteFacet with only processRoute (no registry functions)
        LibDiamond.FacetCut[] memory cut = new LibDiamond.FacetCut[](1);
        bytes4[] memory selectors = new bytes4[](1);
        selectors[0] = CoreRouteFacet.processRoute.selector;

        cut[0] = LibDiamond.FacetCut({
            facetAddress: address(coreRouteFacet),
            action: LibDiamond.FacetCutAction.Add,
            functionSelectors: selectors
        });

        vm.prank(USER_DIAMOND_OWNER);
        LibDiamond.diamondCut(cut, address(0), "");

        coreRouteFacet = CoreRouteFacet(address(ldaDiamond));
        vm.label(address(ldaDiamond), "LdaDiamond");
        vm.label(address(coreRouteFacet), "CoreRouteFacet");
    }

    function addFacet(address facetAddress, bytes4 swapSelector) internal {
        // Simple facet addition - no registration needed
        LibDiamond.FacetCut[] memory cut = new LibDiamond.FacetCut[](1);
        bytes4[] memory selectors = new bytes4[](1);
        selectors[0] = swapSelector;

        cut[0] = LibDiamond.FacetCut({
            facetAddress: facetAddress,
            action: LibDiamond.FacetCutAction.Add,
            functionSelectors: selectors
        });

        vm.prank(USER_DIAMOND_OWNER);
        LibDiamond.diamondCut(cut, address(0), "");
    }

    function buildRoute(
        address tokenIn,
        uint256 amountIn,
        bytes4 selector,
        bytes memory poolData
    ) internal pure returns (bytes memory) {
        return abi.encodePacked(
            uint8(2), // processUserERC20
            tokenIn,
            uint8(1), // number of pools
            uint16(65535), // full share
            selector,
            poolData
        );
    }

    // Abstract test functions
    function test_CanSwap() public virtual;
    function test_CanSwap_FromDiamond() public virtual;
    function test_CanSwap_MultiHop() public virtual;
    function test_FieldValidation() public virtual;

    // Direction constants
    uint8 internal constant DIRECTION_TOKEN0_TO_TOKEN1 = 1;
    uint8 internal constant DIRECTION_TOKEN1_TO_TOKEN0 = 0;
    uint16 internal constant FULL_SHARE = 65535;
}

```

### **Example FooFacet.t.sol**

```solidity
/// DRAFT file for FooFacet.t.sol
/// DRAFT file for FooFacet.t.sol
/// DRAFT file for FooFacet.t.sol

contract FooFacetTest is LdaTestBase {
    FooFacet internal fooFacet;

    function setUp() public override {
        super.setUp();
        fooFacet = new FooFacet();
        addFacet(address(fooFacet), fooFacet.swapFoo.selector);
    }

    function test_CanSwap() public override {
        bytes memory route = buildSelectorRoute(
            address(tokenA),
            1000e18,
            fooFacet.swapFoo.selector,
            abi.encodePacked(address(pool), uint8(1), address(USER_RECEIVER))
        );

        vm.prank(USER_SENDER);
        uint256 amountOut = coreRouteFacet.processRoute(
            address(tokenA), 1000e18, address(tokenB), 950e18, USER_RECEIVER, route
        );

        assertGt(amountOut, 950e18);
    }

    function test_CanSwap_FromDiamond() public override {
    }

    function test_CanSwap_MultiHop() public override {
    }

    function test_FieldValidation() public override {
    }
}

```

### **Deployment Scripts**

- `script/deploy/lda/facets/DeployXFacet.s.sol`
- `scriptMaster.sh` — simple Diamond cut, no registration needed

### **Migration Path**

- Backend needs to map every dex to correct facet swap function selector bytes

---

### **7.3 Migration Requirements**

**Registry Approach (Approach 1):**

- Smart contract: Deploy facets + register dexTypes
- Backend: No changes needed (keeps existing dexType system)

**Selector Approach (Approach 2):**

- Smart contract: Deploy facets (no registration)
- Backend: Update route encoding to use selectors instead of dexTypes

---

## **8. Detailed Approach Analysis**

### **8.1 Backend Communication Comparison**

**Current Complexity (OLD/Approach 1):**

- Backend/Smart contract teams need to understand `poolType/dexType` mappings
- Complex enum/mapping management
- Multiple DEXs share same `poolType/dexType` identifier
- Requires coordination for `poolType/dexType` assignments

**Simplified Communication (Approach 2):**

- **Simpler mapping**: Compatible DEXs share selectors, callback-requiring DEXs get unique selectors
- **No enum management**: Direct function selector usage
- **Self-documenting**: `PancakeV3Facet.swapPancakeV3.selector` is clear
- **Reduced coordination**: Deploy facet → get selector → use immediately

Regarding communication with the backend team, **Approach 2 significantly simplifies coordination**. Currently, we need to communicate which `dexType` each DEX should use, requiring mapping management and potential conflicts. With the selector approach, communication becomes **clearer and more explicit**: compatible DEXs share selectors while callback-requiring DEXs get unique selectors, reducing the need for complex enum management and coordination overhead.

### **8.2 DEX Grouping by Compatibility**

**Selector sharing patterns:**

- **UniV2-compatible DEXs**: All share `UniswapV2StyleFacet.swapUniV2.selector`
    - UniswapV2, SushiSwap, PancakeV2, TraderJoe V1, etc.
    - Only pool address differs in route data
- **UniV3-compatible DEXs**: Each gets unique selector due to callback differences
    - UniV3 → `UniV3Facet.swapUniV3.selector`
    - PancakeV3 → `PancakeV3Facet.swapPancakeV3.selector`
    - RamsesV2 → `RamsesV2Facet.swapRamsesV2.selector`
    - Different callback function names require separate facets
- **Unique protocol DEXs**: Each gets its own selector
    - Curve, Balancer, 1inch, etc.
    - Different swap interfaces and callback patterns

## **9. Final Approach Comparison Matrix**

| **Aspect** | **OLD (Monolithic)** | **Approach 1 (Registry)** | **Approach 2 (Selector)** | **Notes** |
| --- | --- | --- | --- | --- |
| **Backend Changes** | ✅ None (current system) | ✅ None (keeps dexType) | ❌ Requires route encoding update | One-time migration to selector based routing |
| **User Gas Cost** | ~50-200 gas (growing) | ~2,100 gas (constant) | ~20 gas (constant) |  |
| **DEX Integration** | ❌ Update CoreRouteFacet | ✅ Register dexType | ✅ Deploy and use |  |
| **Backend Changes** | N/A | ✅ None (keep dexType system) | ✅ Minor (selector mapping) |  |
| **Scalability** | ❌ Limited by contract size | ✅ 255 DEXs (uint8) | ✅ 4 billion DEXs (bytes4) |  |
| **Deployment Complexity** | ❌ High | ❌ Medium (dependencies) | ✅ Minimal (independent) |  |
| **Deployment Order** | N/A | ❌ Must follow dependency order | ✅ Any order |  |
| **Facet Dependencies** | N/A | ❌ Hard dependencies exist | ✅ Zero dependencies |  |
| **Single Point of Failure** | ❌ Monolithic contract | ❌ Registry corruption | ✅ No central registry |  |
| **Gas Predictability** | ❌ Increases with DEXs | ✅ Constant | ✅ Constant |  |
| **Code Reuse** | N/A | ✅ High (shared swap functions) | ✅ Medium (via libraries) |  |
| **Test Setup Complexity** | ❌ Massive test suite | ❌ Higher (registry setup) | ✅ Lower (direct facet addition) |  |
| **Test Isolation** | ❌ Monolithic coupling | ❌ Medium (shared registry) | ✅ High (independent facets) |  |
| **Maintenance** | ❌ Fragile monolith | ❌ Fragile interdependencies | ✅ Clear separation |  |
| **Upgrade Safety** | ❌ Monolithic failure | ❌ Cascade failures possible | ✅ Isolated failures |  |
| **Bytecode Size** | ❌ Massive monolith | ✅ Smaller (less duplication) | ❌ Larger (each facet complete) | with selector approach its larger but still great fit for facet |

> Note:
> 
> 
> Approach 1 (Registry-based) was my **initial approach**, which is why I've kept it in the documentation — just to let you know it's still a valid and fully working option. It allows us to onboard new DEXs **without requiring any changes on the backend**, since the backend can continue using the existing `dexType` field. That said, we'd need to ask the LDA backend team whether they're capable and willing to switch to using function selectors (required by Approach 2).
> 
> Personally, I recommend Approach 2 going forward. It reduces backend coordination, scales better, and is more explicit and maintainable. You simply deploy a new facet, use its selector directly, and avoid all shared-state registry management or dependency tracking.
> 

---

# **Part II: Development Standards & Tooling (common for both approaches)**

## **10. Callback Handling: From `lastCalledPool` → `CallbackManager`**

OLD:

```solidity
lastCalledPool = pool; // in swap function
...
require(msg.sender == lastCalledPool); // in callback function

```

**NEW:**

We now use the **`CallbackManager` library**, which stores the expected sender in diamond-safe storage.

**Step-by-step usage:**

1. **Arm** the callback guard in the swap function (before external call)
2. **Verify** or use the `onlyExpectedCallback` modifier at the beginning of the callback
3. **Clear** the state after validation (modifier handles it automatically)

**`CallbackManager.sol`** (in `/Libraries`):

```solidity

// DRAFT file for LibCallbackManager.sol
// DRAFT file for LibCallbackManager.sol
// DRAFT file for LibCallbackManager.sol

// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

error UnexpectedCallbackSender(address actual, address expected);

library LibCallbackManager {
    bytes32 internal constant NAMESPACE = keccak256("com.lifi.lda.callbackmanager");

    struct Data {
        address expected;
    }

    function data() internal pure returns (Data storage d) {
        bytes32 p = NAMESPACE;
        assembly {
            d.slot := p
        }
    }

    /// @notice Arm the guard with expected pool
    function arm(address expectedCallbackSender) internal {
        data().expected = expectedCallbackSender;
    }

    /// @notice Clear the guard (called inside the callback)
    function clear() internal {
        data().expected = address(0);
    }

    /// @notice Check that callback comes from expected address
    function verifyCallbackSender() internal view {
        address expected = data().expected;
        if (msg.sender != expected) {
            revert UnexpectedCallbackSender(msg.sender, expected);
        }
    }

    /// @dev Wraps a callback with verify + clear. To use with `using CallbackManager for *`.
    modifier onlyExpectedCallback() {
        verifyCallbackSender();
        _;
        clear();
    }
}

```

Example usage:

```solidity
// DRAFT file for FooFacet.sol
// DRAFT file for FooFacet.sol
// DRAFT file for FooFacet.sol

import { LibCallbackManager } from "lifi/Libraries/LibCallbackManager.sol";

contract FooFacet {
    using LibCallbackManager for *;

    function swapFoo(
        uint256 stream,
        address from,
        address tokenIn,
        uint256 amountIn
    ) external returns (uint256 amountOut) {
        address pool = decodePoolFromStream(stream);

        // arm callback guard
        LibCallbackManager.arm(pool);

        // call to external pool
        IFooPool(pool).swap(tokenIn, amountIn, ...);

        // actual result will be handled via callback
    }

    /// @notice Callback triggered by FooPool
    function fooSwapCallback(bytes calldata data) external LibCallbackManager.onlyExpectedCallback {
        // sender verified + cleared automatically

        // Perform balance check, token transfer, emit event, etc.
    }
}

```

## **11. Release Checklist**

Release checklist same based on [New Facet Contract Checklist](https://www.notion.so/New-Facet-Contract-Checklist-157f0ff14ac78095a2b8f999d655622e?pvs=21)

## **12. Conventions & Cleanup**

- all `DEX_TYPE` constants in a shared `DexTypes.sol` (Registry approach)
- use `LibAsset` for transfers
- update [`conventions.md`](http://conventions.md/) accordingly

## **13. Code Generation**

We use `plop` to scaffold new facet modules with all required boilerplate:

```bash
bun run plop facet
```

You will be prompted with:

```
? What kind of facet do you want to generate?
> [1] Main Diamond (e.g. LiFiDiamond)
> [2] LDA Diamond (e.g. LDALiFiDiamond)
? Which approach are you using?
> [1] Registry-based (Approach 1)
> [2] Selector-based (Approach 2)

```

### **Plop Output:**

- **Path:** `src/Lda/Facets/FooFacet.sol`
- **Test:** `test/solidity/Lda/Facets/FooFacet.t.sol` (extends `LdaTestBase`)
- **Deploy script:** `script/deploy/lda/facets/DeployFooFacet.s.sol`
- **Update script:** `script/deploy/lda/facets/UpdateFooFacet.s.sol`
- **Docs:** `docs/lda/FooFacet.md`

**Questions:** 

Can we deprecate bento?