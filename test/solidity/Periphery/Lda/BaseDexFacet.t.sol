// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.17;

import { LdaDiamondTest } from "./utils/LdaDiamondTest.sol";
import { TestHelpers } from "../../utils/TestHelpers.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { CoreRouteFacet } from "lifi/Periphery/Lda/Facets/CoreRouteFacet.sol";

/**
 * @title BaseDexFacetTest
 * @notice Base test contract with common functionality and abstractions for DEX-specific tests
 */
abstract contract BaseDexFacetTest is LdaDiamondTest, TestHelpers {
    using SafeERC20 for IERC20;

    struct ForkConfig {
        string rpcEnvName;
        uint256 blockNumber;
    }

    // Command codes for route processing
    enum CommandType {
        None, // 0 - not used
        ProcessMyERC20, // 1 - processMyERC20
        ProcessUserERC20, // 2 - processUserERC20
        ProcessNative, // 3 - processNative
        ProcessOnePool, // 4 - processOnePool
        ProcessInsideBento, // 5 - processInsideBento
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

    function _addDexFacet() internal virtual;

    // Setup function for Apechain tests
    function setupApechain() internal {
        customRpcUrlForForking = "ETH_NODE_URI_APECHAIN";
        customBlockNumberForForking = 12912470;
    }

    function setupHyperEVM() internal {
        customRpcUrlForForking = "ETH_NODE_URI_HYPEREVM";
        customBlockNumberForForking = 4433562;
    }

    function setupXDC() internal {
        customRpcUrlForForking = "ETH_NODE_URI_XDC";
        customBlockNumberForForking = 89279495;
    }

    function setupViction() internal {
        customRpcUrlForForking = "ETH_NODE_URI_VICTION";
        customBlockNumberForForking = 94490946;
    }

    function setupFlare() internal {
        customRpcUrlForForking = "ETH_NODE_URI_FLARE";
        customBlockNumberForForking = 42652369;
    }

    function setupLinea() internal {
        customRpcUrlForForking = "ETH_NODE_URI_LINEA";
        customBlockNumberForForking = 20077881;
    }

    function setUp() public virtual override {
        // forkConfig should be set in the child contract via _setupForkConfig()
        _setupForkConfig();
        // TODO if rpcEnvName is not set, revert
        // TODO if blockNumber is not set, revert
        customRpcUrlForForking = forkConfig.rpcEnvName;
        customBlockNumberForForking = forkConfig.blockNumber;

        fork();
        LdaDiamondTest.setUp();
        _addCoreRouteFacet();
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

    // function test_ContractIsSetUpCorrectly() public {
    //     assertEq(address(liFiDEXAggregator.BENTO_BOX()), address(0xCAFE));
    //     assertEq(
    //         liFiDEXAggregator.priviledgedUsers(address(USER_DIAMOND_OWNER)),
    //         true
    //     );
    //     assertEq(liFiDEXAggregator.owner(), USER_DIAMOND_OWNER);
    // }

    // function testRevert_FailsIfOwnerIsZeroAddress() public {
    //     vm.expectRevert(InvalidConfig.selector);

    //     liFiDEXAggregator = new LiFiDEXAggregator(
    //         address(0xCAFE),
    //         privileged,
    //         address(0)
    //     );
    // }

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
}
