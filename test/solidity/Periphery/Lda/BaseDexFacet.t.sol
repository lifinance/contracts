// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.17;

import { LdaDiamondTest } from "./utils/LdaDiamondTest.sol";
import { TestHelpers } from "../../utils/TestHelpers.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { CoreRouteFacet } from "lifi/Periphery/Lda/Facets/CoreRouteFacet.sol";
import { stdJson } from "forge-std/StdJson.sol";

/**
 * @title BaseDexFacetTest
 * @notice Base test contract with common functionality and abstractions for DEX-specific tests
 */
abstract contract BaseDexFacetTest is LdaDiamondTest, TestHelpers {
    using SafeERC20 for IERC20;

    struct ForkConfig {
        string networkName; // e.g. "taiko" (not "ETH_NODE_URI_TAIKO")
        uint256 blockNumber;
    }

    // Command codes for route processing
    enum CommandType {
        None, // 0 - not used
        ProcessMyERC20, // 1 - processMyERC20 (Aggregator's funds)
        ProcessUserERC20, // 2 - processUserERC20 (User's funds)
        ProcessNative, // 3 - processNative
        ProcessOnePool, // 4 - processOnePool (Pool's funds)
        ApplyPermit // 6 - applyPermit
    }

    // Direction constants
    enum SwapDirection {
        Token1ToToken0, // 0
        Token0ToToken1 // 1
    }

    // Callback constants
    enum CallbackStatus {
        Disabled, // 0
        Enabled // 1
    }

    CoreRouteFacet internal coreRouteFacet;
    ForkConfig internal forkConfig;

    // Other constants
    uint16 internal constant FULL_SHARE = 65535; // 100% share for single pool swaps

    // Common events and errors
    event Route(
        address indexed from,
        address to,
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOutMin,
        uint256 amountOut
    );
    event HookCalled(
        address sender,
        uint256 amount0,
        uint256 amount1,
        bytes data
    );

    error WrongPoolReserves();
    error PoolDoesNotExist();

    // Add custom errors at the top of the contract
    error ParamsDataLengthMismatch();
    error NoHopsProvided();
    error InvalidForkConfig(string reason);
    error UnknownNetwork(string name);

    // Add this struct to hold event expectations
    struct ExpectedEvent {
        bool checkTopic1;
        bool checkTopic2;
        bool checkTopic3;
        bool checkData;
        bytes32 eventSelector; // The event selector (keccak256 hash of the event signature)
        bytes[] eventParams; // The event parameters, each encoded separately
    }

    // At top-level state
    IERC20 internal tokenIn;
    IERC20 internal tokenMid; // optional for multi-hop
    IERC20 internal tokenOut;

    address internal poolInOut; // for single hop or UniV2-style
    address internal poolInMid; // for hop 1
    address internal poolMidOut; // for hop 2

    // Optional flag/hook for aggregator slot-undrain behavior
    bool internal aggregatorUndrainMinusOne;

    function _addDexFacet() internal virtual {
        (
            address facetAddress,
            bytes4[] memory functionSelectors
        ) = _createFacetAndSelectors();

        addFacet(address(ldaDiamond), facetAddress, functionSelectors);

        _setFacetInstance(payable(address(ldaDiamond)));
    }

    // Each facet test must implement these
    function _createFacetAndSelectors()
        internal
        virtual
        returns (address, bytes4[] memory);
    function _setFacetInstance(address payable facetAddress) internal virtual;

    function _setupDexEnv() internal virtual;

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
        LdaDiamondTest.setUp();
        _addCoreRouteFacet();
        _setupDexEnv(); // populate tokens/pools
        _addDexFacet();
    }

    function _addCoreRouteFacet() internal {
        coreRouteFacet = new CoreRouteFacet();
        bytes4[] memory functionSelectors = new bytes4[](1);
        functionSelectors[0] = CoreRouteFacet.processRoute.selector;
        addFacet(
            address(ldaDiamond),
            address(coreRouteFacet),
            functionSelectors
        );

        coreRouteFacet = CoreRouteFacet(payable(address(ldaDiamond)));
    }

    function _setupForkConfig() internal virtual;

    // ============================ Abstract DEX Tests ============================
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

    struct SwapTestParams {
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        address sender;
        address recipient;
        CommandType commandType;
    }

    // Add this struct for route building
    struct RouteParams {
        CommandType commandType;
        address tokenIn;
        uint8 numPools; // defaults to 1
        uint16 share; // defaults to FULL_SHARE
        bytes swapData;
    }

    // Helper to build common route parts
    function _buildBaseRoute(
        SwapTestParams memory params,
        bytes memory swapData
    ) internal pure returns (bytes memory) {
        if (params.commandType == CommandType.ProcessOnePool) {
            return
                abi.encodePacked(
                    uint8(params.commandType),
                    params.tokenIn,
                    uint16(swapData.length),
                    swapData
                );
        } else {
            return
                abi.encodePacked(
                    uint8(params.commandType),
                    params.tokenIn,
                    uint8(1), // one pool
                    FULL_SHARE, // 100%
                    uint16(swapData.length),
                    swapData
                );
        }
    }

    // Helper for building multi-hop route
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

    function _executeAndVerifySwap(
        SwapTestParams memory params,
        bytes memory route,
        ExpectedEvent[] memory additionalEvents,
        bool isFeeOnTransferToken
    ) internal {
        if (params.commandType != CommandType.ProcessMyERC20) {
            IERC20(params.tokenIn).approve(
                address(ldaDiamond),
                params.amountIn
            );
        }

        uint256 inBefore;
        uint256 outBefore = IERC20(params.tokenOut).balanceOf(
            params.recipient
        );

        // For aggregator funds, check the diamond's balance
        if (params.commandType == CommandType.ProcessMyERC20) {
            inBefore = IERC20(params.tokenIn).balanceOf(address(ldaDiamond));
        } else {
            inBefore = IERC20(params.tokenIn).balanceOf(params.sender);
        }

        // Set up additional event expectations first
        for (uint256 i = 0; i < additionalEvents.length; i++) {
            vm.expectEmit(
                additionalEvents[i].checkTopic1,
                additionalEvents[i].checkTopic2,
                additionalEvents[i].checkTopic3,
                additionalEvents[i].checkData
            );

            // Encode event parameters
            bytes memory encodedParams;
            for (
                uint256 j = 0;
                j < additionalEvents[i].eventParams.length;
                j++
            ) {
                encodedParams = bytes.concat(
                    encodedParams,
                    additionalEvents[i].eventParams[j]
                );
            }

            // Emit the event with the correct selector and parameters
            assembly {
                let selector := mload(
                    add(mload(add(additionalEvents, 0x20)), 0x80)
                ) // access eventSelector
                mstore(0x00, selector)
                mstore(0x04, encodedParams)
                log1(0x00, add(0x04, mload(encodedParams)), selector)
            }
        }

        coreRouteFacet.processRoute(
            params.tokenIn,
            params.amountIn,
            params.tokenOut,
            0, // minOut = 0 for tests
            params.recipient,
            route
        );

        uint256 inAfter;
        uint256 outAfter = IERC20(params.tokenOut).balanceOf(params.recipient);

        // Check balance change on the correct address
        if (params.commandType == CommandType.ProcessMyERC20) {
            inAfter = IERC20(params.tokenIn).balanceOf(address(ldaDiamond));
        } else {
            inAfter = IERC20(params.tokenIn).balanceOf(params.sender);
        }

        // Use assertEq or assertApproxEqAbs based on isFeeOnTransferToken
        if (isFeeOnTransferToken) {
            assertApproxEqAbs(
                inBefore - inAfter,
                params.amountIn,
                1, // Allow 1 wei difference for fee-on-transfer tokens
                "Token spent mismatch"
            );
        } else {
            assertEq(
                inBefore - inAfter,
                params.amountIn,
                "Token spent mismatch"
            );
        }

        assertGt(outAfter - outBefore, 0, "Should receive tokens");
    }

    function _getDefaultAmountForTokenIn() internal virtual returns (uint256) {
        return 1_000 * 1e18; // Default, can be overridden
    }

    function _executeAndVerifySwap(
        SwapTestParams memory params,
        bytes memory route,
        ExpectedEvent[] memory additionalEvents
    ) internal {
        _executeAndVerifySwap(params, route, additionalEvents, false);
    }

    function _executeAndVerifySwap(
        SwapTestParams memory params,
        bytes memory route
    ) internal {
        _executeAndVerifySwap(params, route, new ExpectedEvent[](0), false);
    }

    // Keep the revert case separate
    function _executeAndVerifySwap(
        SwapTestParams memory params,
        bytes memory route,
        bytes4 expectedRevert
    ) internal {
        if (params.commandType != CommandType.ProcessMyERC20) {
            IERC20(params.tokenIn).approve(
                address(ldaDiamond),
                params.amountIn
            );
        }

        vm.expectRevert(expectedRevert);
        coreRouteFacet.processRoute(
            params.tokenIn,
            params.commandType == CommandType.ProcessMyERC20
                ? params.amountIn
                : params.amountIn - 1,
            params.tokenOut,
            0, // minOut = 0 for tests
            params.recipient,
            route
        );
    }
}
