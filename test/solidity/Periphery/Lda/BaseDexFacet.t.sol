// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { BaseCoreRouteTest } from "./BaseCoreRouteTest.t.sol";
import { stdJson } from "forge-std/StdJson.sol";

/**
 * @title BaseDEXFacetTest
 * @notice Base test contract with common functionality and abstractions for DEX-specific tests.
 * @dev Child tests implement the virtual hooks to:
 *      - choose fork/network
 *      - set pool/token addresses
 *      - deploy and register their DEX facet + callback (if applicable)
 *
 *      Usage:
 *      - Inherit and implement `_setupForkConfig`, `_setupDexEnv`,
 *        and facet creation hooks.
 *      - Call core helpers like `_buildMultiHopRoute` and `_addDexFacet`.
 */
abstract contract BaseDEXFacetTest is BaseCoreRouteTest {
    using SafeERC20 for IERC20;

    // ==== Types ====

    /// @notice Encapsulates a fork target used by setUp().
    /// @param networkName A key into config/networks.json and an ENV suffix for ETH_NODE_URI_<NAME>.
    /// @param blockNumber Block height to fork at.
    struct ForkConfig {
        string networkName;
        uint256 blockNumber;
    }

    /// @notice Describes swap direction for two-token pools.
    /// @dev TokenXToTokenY values map to pool-specific zeroForOne flags.
    enum SwapDirection {
        Token1ToToken0, // 0
        Token0ToToken1 // 1
    }

    // ==== Events ====

    // ==== Errors ====

    /// @notice Thrown when an expected pool reserve shape is not met in setup.
    error WrongPoolReserves();
    /// @notice Thrown when a required on-chain pool does not exist.
    error PoolDoesNotExist();
    /// @notice Thrown when hopParams and hopData arrays differ in length.
    error ParamsDataLengthMismatch();
    /// @notice Thrown when no hops were provided to `_buildMultiHopRoute`.
    error NoHopsProvided();
    /// @notice Thrown when setUp fork config is invalid.
    /// @param reason A human-readable reason.
    error InvalidForkConfig(string reason);
    /// @notice Thrown when networkName is not found in config/networks.json.
    /// @param name The missing network name.
    error UnknownNetwork(string name);

    // Custom errors for abstract test functions
    /// @notice Thrown when test_CanSwap is not implemented by child contract.
    error TestCanSwapNotImplemented();
    /// @notice Thrown when test_CanSwap_FromDexAggregator is not implemented by child contract.
    error TestCanSwapFromDexAggregatorNotImplemented();
    /// @notice Thrown when test_CanSwap_MultiHop is not implemented by child contract.
    error TestCanSwapMultiHopNotImplemented();
    /// @notice Thrown when testRevert_CallbackFromUnexpectedSender is not implemented by child contract.
    error TestRevertCallbackFromUnexpectedSenderNotImplemented();
    /// @notice Thrown when testRevert_SwapWithoutCallback is not implemented by child contract.
    error TestRevertSwapWithoutCallbackNotImplemented();

    // ==== Storage Variables ====

    /// @notice Active fork settings for this test.
    ForkConfig internal forkConfig;

    /// @notice Primary input token for single-hop tests.
    IERC20 internal tokenIn;
    /// @notice Optional middle token for multi-hop tests.
    IERC20 internal tokenMid; // optional for multi-hop
    /// @notice Primary output token for single-hop tests.
    IERC20 internal tokenOut;

    /// @notice Pool for tokenIn->tokenOut single-hop routes or UniV2-style.
    address internal poolInOut; // for single hop or UniV2-style
    /// @notice Pool for hop 1 in multi-hop tests.
    address internal poolInMid; // for hop 1
    /// @notice Pool for hop 2 in multi-hop tests.
    address internal poolMidOut; // for hop 2

    // ==== Virtual Functions ====

    /// @notice Child must deploy its facet and return its function selectors.
    /// @return facetAddress Address of the facet implementation.
    /// @return functionSelectors Selectors to add to the diamond.
    function _createFacetAndSelectors()
        internal
        virtual
        returns (address, bytes4[] memory);

    /// @notice Child must set its facet instance to the diamond proxy.
    /// @param facetAddress Address of the diamond proxy that now exposes the facet.
    function _setFacetInstance(address payable facetAddress) internal virtual;

    /// @notice Child must configure tokens/pools for the selected fork.
    function _setupDexEnv() internal virtual;

    /// @notice Child must set `forkConfig` with target network + block.
    function _setupForkConfig() internal virtual;

    // ==== Setup Functions ====

    /// @notice Forks the configured network, validates ENV, and attaches the DEX facet to LDA.
    /// @dev Validates:
    ///      - ENV var ETH_NODE_URI_<UPPER_NETWORK_NAME>
    ///      - key existence in config/networks.json
    ///      - non-zero block number
    ///      Then forks and sets up the DEX env and adds the DEX facet to the LDA diamond.
    function setUp() public virtual override {
        _setupForkConfig();

        // Validate network name
        if (bytes(forkConfig.networkName).length == 0) {
            revert InvalidForkConfig("networkName not set");
        }

        // Validate block number
        if (forkConfig.blockNumber == 0) {
            revert InvalidForkConfig("blockNumber not set");
        }

        // Compute RPC URL and validate it exists
        string memory rpc = string.concat(
            "ETH_NODE_URI_",
            _convertToUpperCase(forkConfig.networkName)
        );

        try vm.envString(rpc) returns (string memory rpcUrl) {
            if (bytes(rpcUrl).length == 0) {
                revert InvalidForkConfig("RPC URL is empty");
            }
            customRpcUrlForForking = rpc;
        } catch {
            revert InvalidForkConfig("RPC URL not found");
        }

        // optional validation against networks.json
        _ensureNetworkExists(forkConfig.networkName);

        customBlockNumberForForking = forkConfig.blockNumber;

        fork();
        super.setUp();
        _setupDexEnv(); // populate tokens/pools
        _addDexFacet();
    }

    // ==== Internal Functions ====

    /// @notice Deploys and adds the child DEX facet to the LDA diamond.
    /// @dev Uses `_createFacetAndSelectors` hook to deploy and collect selectors,
    ///      performs diamondCut, and then updates the facet instance to the diamond proxy via `_setFacetInstance`.
    function _addDexFacet() internal virtual {
        (
            address facetAddress,
            bytes4[] memory functionSelectors
        ) = _createFacetAndSelectors();

        addFacet(address(ldaDiamond), facetAddress, functionSelectors);

        _setFacetInstance(payable(address(ldaDiamond)));
    }

    // ==== Helper Functions ====

    /// @notice Converts lowercase ASCII to uppercase; leaves non-letters unmodified.
    /// @param s Input string.
    /// @return Uppercased string.
    function _convertToUpperCase(
        string memory s
    ) internal pure returns (string memory) {
        bytes memory b = bytes(s);
        for (uint256 i; i < b.length; i++) {
            uint8 c = uint8(b[i]);
            if (c >= 97 && c <= 122) {
                b[i] = bytes1(c - 32);
            }
        }
        return string(b);
    }

    /// @notice Ensures a network key exists in `config/networks.json`.
    /// @param name Network name to validate.
    /// @dev Reads `.<network>.name` and reverts if missing.
    function _ensureNetworkExists(string memory name) internal {
        // will revert if the key path is missing
        string memory json = vm.readFile("config/networks.json");
        // read the ".<networkName>.name" path to confirm key presence
        string memory path = string.concat(".", name, ".name");
        string memory value = stdJson.readString(json, path);
        if (bytes(value).length == 0) {
            revert UnknownNetwork(name);
        }
    }

    /// @notice Concatenates multiple base routes into a single multi-hop route for `processRoute`.
    /// @param hopParams Array of hop parameters (tokenIn/out, amountIn, sender/destinationAddress, command type).
    /// @param hopData Array of corresponding DEX-specific swap data for each hop.
    /// @return Concatenated route bytes suitable for `CoreRouteFacet.processRoute`.
    /// @dev Reverts if arrays mismatch or empty. Example:
    ///      - Hop0: user ERC20 A -> aggregator, UniV2.pool0
    ///      - Hop1: aggregator ERC20 B -> user, Algebra.pool1 (supports fee-on-transfer)
    function _buildMultiHopRoute(
        SwapTestParams[] memory hopParams,
        bytes[] memory hopData
    ) internal pure returns (bytes memory) {
        if (hopParams.length != hopData.length)
            revert ParamsDataLengthMismatch();
        if (hopParams.length == 0) revert NoHopsProvided();

        bytes memory route;
        for (uint256 i = 0; i < hopParams.length; i++) {
            route = bytes.concat(
                route,
                _buildBaseRoute(hopParams[i], hopData[i])
            );
        }
        return route;
    }

    /// @notice Default amount for `tokenIn` used by derived tests.
    /// @return Default amount, override to adapt per pool/tokenIn/decimals.
    function _getDefaultAmountForTokenIn()
        internal
        pure
        virtual
        returns (uint256)
    {
        return 1_000 * 1e18;
    }

    // ==== Abstract Test Cases ====

    /// @notice Abstract test stub: must be implemented by concrete DEX tests to validate basic swapping.
    function test_CanSwap() public virtual {
        // Each DEX implementation must override this
        revert TestCanSwapNotImplemented();
    }

    /// @notice Abstract test stub: must be implemented by concrete DEX tests to validate aggregator-funded swap.
    function test_CanSwap_FromDexAggregator() public virtual {
        // Each DEX implementation must override this
        revert TestCanSwapFromDexAggregatorNotImplemented();
    }

    /// @notice Abstract test stub: must be implemented by concrete DEX tests to validate multi-hop routing.
    function test_CanSwap_MultiHop() public virtual {
        // Each DEX implementation must override this
        revert TestCanSwapMultiHopNotImplemented();
    }

    /// @notice Abstract test stub: for DEXes with callbacks, ensure callback cannot be called by unexpected senders.
    function testRevert_CallbackFromUnexpectedSender() public virtual {
        // Each DEX implementation with callbacks must override this
        // DEXs without callbacks should leave this empty
        revert TestRevertCallbackFromUnexpectedSenderNotImplemented();
    }

    /// @notice Abstract test stub: for DEXes with callbacks, ensure swap reverts if callback is not executed.
    function testRevert_SwapWithoutCallback() public virtual {
        // Each DEX implementation with callbacks must override this
        // DEXs without callbacks should leave this empty
        revert TestRevertSwapWithoutCallbackNotImplemented();
    }
}
