// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.17;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { BaseCoreRouteTest } from "./BaseCoreRouteTest.t.sol";
import { stdJson } from "forge-std/StdJson.sol";

/**
 * @title BaseDexFacetTest
 * @notice Base test contract with common functionality and abstractions for DEX-specific tests
 */
abstract contract BaseDexFacetTest is BaseCoreRouteTest {
    using SafeERC20 for IERC20;

    // ==== Types ====
    struct ForkConfig {
        string networkName;
        uint256 blockNumber;
    }

    enum SwapDirection {
        Token1ToToken0, // 0
        Token0ToToken1 // 1
    }

    struct RouteParams {
        CommandType commandType;
        address tokenIn;
        uint8 numPools; // defaults to 1
        uint16 share; // defaults to FULL_SHARE
        bytes swapData;
    }

    // ==== Events ====
    event HookCalled(
        address sender,
        uint256 amount0,
        uint256 amount1,
        bytes data
    );

    // ==== Errors ====
    error WrongPoolReserves();
    error PoolDoesNotExist();
    error ParamsDataLengthMismatch();
    error NoHopsProvided();
    error InvalidForkConfig(string reason);
    error UnknownNetwork(string name);

    // ==== Storage Variables ====
    ForkConfig internal forkConfig;

    IERC20 internal tokenIn;
    IERC20 internal tokenMid; // optional for multi-hop
    IERC20 internal tokenOut;

    address internal poolInOut; // for single hop or UniV2-style
    address internal poolInMid; // for hop 1
    address internal poolMidOut; // for hop 2

    // Optional flag/hook for aggregator slot-undrain behavior
    bool internal aggregatorUndrainMinusOne;

    // ==== Virtual Functions ====
    function _createFacetAndSelectors()
        internal
        virtual
        returns (address, bytes4[] memory);

    function _setFacetInstance(address payable facetAddress) internal virtual;

    function _setupDexEnv() internal virtual;

    function _setupForkConfig() internal virtual;

    // ==== Setup Functions ====
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
        BaseCoreRouteTest.setUp();
        _setupDexEnv(); // populate tokens/pools
        _addDexFacet();
    }

    // ==== Internal Functions ====
    function _addDexFacet() internal virtual {
        (
            address facetAddress,
            bytes4[] memory functionSelectors
        ) = _createFacetAndSelectors();

        addFacet(ldaDiamond, facetAddress, functionSelectors);

        _setFacetInstance(payable(address(ldaDiamond)));
    }

    // ==== Helper Functions ====
    // helper to uppercase ASCII
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

    // optional: ensure key exists in config/networks.json
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

    function _getDefaultAmountForTokenIn()
        internal
        pure
        virtual
        returns (uint256)
    {
        return 1_000 * 1e18;
    }

    // ==== Abstract Test Cases ====
    /**
     * @notice Abstract test for basic token swapping functionality
     * Each DEX implementation should override this
     */
    function test_CanSwap() public virtual {
        // Each DEX implementation must override this
        // solhint-disable-next-line gas-custom-errors
        revert("test_CanSwap: Not implemented");
    }

    /**
     * @notice Abstract test for swapping tokens from the DEX aggregator
     * Each DEX implementation should override this
     */
    function test_CanSwap_FromDexAggregator() public virtual {
        // Each DEX implementation must override this
        // solhint-disable-next-line gas-custom-errors
        revert("test_CanSwap_FromDexAggregator: Not implemented");
    }

    /**
     * @notice Abstract test for multi-hop swapping
     * Each DEX implementation should override this
     */
    function test_CanSwap_MultiHop() public virtual {
        // Each DEX implementation must override this
        // solhint-disable-next-line gas-custom-errors
        revert("test_CanSwap_MultiHop: Not implemented");
    }

    /**
     * @notice Abstract test for verifying callback protection against unauthorized calls
     * @dev DEX implementations with callbacks must override this
     *      DEXs without callbacks should leave this empty
     */
    function testRevert_CallbackFromUnexpectedSender() public virtual {
        // Each DEX implementation with callbacks must override this
        // DEXs without callbacks should leave this empty
        // solhint-disable-next-line gas-custom-errors
        revert("testRevert_CallbackFromUnexpectedSender: Not implemented");
    }

    /**
     * @notice Abstract test for verifying swaps fail if callback is not executed
     * @dev DEX implementations with callbacks must override this
     *      DEXs without callbacks should leave this empty
     */
    function testRevert_SwapWithoutCallback() public virtual {
        // Each DEX implementation with callbacks must override this
        // DEXs without callbacks should leave this empty
        // solhint-disable-next-line gas-custom-errors
        revert("testRevert_SwapWithoutCallback: Not implemented");
    }
}
