// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IAlgebraPool } from "lifi/Interfaces/IAlgebraPool.sol";
import { IAlgebraRouter } from "lifi/Interfaces/IAlgebraRouter.sol";
import { IAlgebraFactory } from "lifi/Interfaces/IAlgebraFactory.sol";
import { IAlgebraQuoter } from "lifi/Interfaces/IAlgebraQuoter.sol";
import { AlgebraFacet } from "lifi/Periphery/LDA/Facets/AlgebraFacet.sol";
import { InvalidCallData } from "lifi/Errors/GenericErrors.sol";
import { SwapCallbackNotExecuted } from "lifi/Periphery/LDA/LiFiDEXAggregatorErrors.sol";
import { TestToken as ERC20 } from "../../../utils/TestToken.sol";
import { MockFeeOnTransferToken } from "../../../utils/MockTokenFeeOnTransfer.sol";
import { BaseDEXFacetWithCallbackTest } from "../BaseDEXFacetWithCallback.t.sol";

/// @title AlgebraFacetTest
/// @notice Forked tests for Algebra pools integrated via LDA CoreRoute.
/// @dev Covers:
///      - user-funded and aggregator-funded swaps
///      - fee-on-transfer compatibility
///      - multi-hop routes combining user and aggregator steps
///      - callback protection and revert scenarios
contract AlgebraFacetTest is BaseDEXFacetWithCallbackTest {
    /// @notice Facet proxy handle exposed on the diamond.
    AlgebraFacet internal algebraFacet;

    // ==== Constants ====

    /// @notice Algebra factory on ApeChain used during fork tests.
    address private constant ALGEBRA_FACTORY_APECHAIN =
        0x10aA510d94E094Bd643677bd2964c3EE085Daffc;
    /// @notice Algebra QuoterV2 on ApeChain used to get expected outputs.
    address private constant ALGEBRA_QUOTER_V2_APECHAIN =
        0x60A186019F81bFD04aFc16c9C01804a04E79e68B;
    /// @notice Random APE_ETH holder used to fund aggregator or users in fork tests.
    address private constant RANDOM_APE_ETH_HOLDER_APECHAIN =
        address(0x1EA5Df273F1b2e0b10554C8F6f7Cc7Ef34F6a51b);

    // ==== Types ====

    /// @notice Parameters for the high-level `_testSwap` helper.
    /// @param from Logical sender (user or aggregator/diamond).
    /// @param destinationAddress Destination address of swap.
    /// @param tokenIn Input token.
    /// @param amountIn Input amount.
    /// @param tokenOut Output token.
    /// @param direction Direction (Token0->Token1 or reverse).
    /// @param supportsFeeOnTransfer Toggle fee-on-transfer compatibility in swap data.
    struct AlgebraSwapTestParams {
        address from;
        address destinationAddress;
        address tokenIn;
        uint256 amountIn;
        address tokenOut;
        SwapDirection direction;
        bool supportsFeeOnTransfer;
    }

    /// @notice Local multi-hop test state used to assemble two Algebra pools and tokens.
    /// @param tokenA First token.
    /// @param tokenB Middle token (can be fee-on-transfer).
    /// @param tokenC Final token.
    /// @param pool1 Pool for A<->B.
    /// @param pool2 Pool for B<->C.
    /// @param amountIn User's first-hop input amount.
    /// @param amountToTransfer Funding amount for user.
    /// @param isFeeOnTransfer Whether tokenB charges fees.
    struct MultiHopTestState {
        IERC20 tokenA;
        IERC20 tokenB; // Can be either regular ERC20 or MockFeeOnTransferToken
        IERC20 tokenC;
        address pool1;
        address pool2;
        uint256 amountIn;
        uint256 amountToTransfer;
        bool isFeeOnTransfer;
    }

    /// @notice Parameters to pack swap data for AlgebraFacet.
    /// @param commandCode Command determining source of funds.
    /// @param tokenIn Input token address.
    /// @param destinationAddress Destination address.
    /// @param pool Algebra pool.
    /// @param supportsFeeOnTransfer Toggle fee-on-transfer handling.
    struct AlgebraRouteParams {
        CommandType commandCode; // 1 for contract funds, 2 for user funds
        address tokenIn; // Input token address
        address destinationAddress; // Address receiving the output tokens
        address pool; // Algebra pool address
        bool supportsFeeOnTransfer; // Whether to support fee-on-transfer tokens
    }

    // ==== Setup Functions ====

    /// @notice Selects `apechain` fork and block height used in tests.
    function _setupForkConfig() internal override {
        forkConfig = ForkConfig({
            networkName: "apechain",
            blockNumber: 12912470
        });
    }

    /// @notice Deploys AlgebraFacet and registers `swapAlgebra` and `algebraSwapCallback`.
    /// @return facetAddress Implementation address.
    /// @return functionSelectors Selectors list (swap + callback).
    function _createFacetAndSelectors()
        internal
        override
        returns (address, bytes4[] memory)
    {
        algebraFacet = new AlgebraFacet();
        bytes4[] memory functionSelectors = new bytes4[](2);
        functionSelectors[0] = algebraFacet.swapAlgebra.selector;
        functionSelectors[1] = algebraFacet.algebraSwapCallback.selector;
        return (address(algebraFacet), functionSelectors);
    }

    /// @notice Binds `algebraFacet` to the diamond proxy after diamondCut.
    /// @param ldaDiamond Diamond proxy address.
    function _setFacetInstance(address payable ldaDiamond) internal override {
        algebraFacet = AlgebraFacet(ldaDiamond);
    }

    /// @notice Sets fork-based token/pool addresses used by tests.
    /// @dev tokenIn/tokenOut chosen for ApeChain, poolInOut resolved accordingly.
    function _setupDexEnv() internal override {
        tokenIn = IERC20(0xcF800F4948D16F23333508191B1B1591daF70438); // APE_ETH_TOKEN
        tokenOut = IERC20(0xf4D9235269a96aaDaFc9aDAe454a0618eBE37949); // WETH_TOKEN
        poolInOut = 0x217076aa74eFF7D54837D00296e9AEBc8c06d4F2; // ALGEBRA_POOL_APECHAIN
    }

    /// @notice Default input amount adapted to 6 decimals for APE_ETH on ApeChain.
    function _getDefaultAmountForTokenIn()
        internal
        pure
        override
        returns (uint256)
    {
        return 1_000 * 1e6;
    }

    // ==== Test Cases ====

    /// @notice Aggregator-funded swap on Algebra using funds transferred from a whale.
    /// @dev Transfers APE_ETH to `ldaDiamond` (aggregator) and executes swap to `USER_SENDER`.
    function test_CanSwap_FromDexAggregator() public override {
        // Fund LDA from whale address
        vm.prank(RANDOM_APE_ETH_HOLDER_APECHAIN);
        IERC20(tokenIn).transfer(
            address(ldaDiamond),
            _getDefaultAmountForTokenIn()
        );

        vm.startPrank(USER_SENDER);

        _testSwap(
            AlgebraSwapTestParams({
                from: address(ldaDiamond),
                destinationAddress: address(USER_SENDER),
                tokenIn: address(tokenIn),
                amountIn: _getDefaultAmountForTokenIn() - 1,
                tokenOut: address(tokenOut),
                direction: SwapDirection.Token0ToToken1,
                supportsFeeOnTransfer: true
            })
        );

        vm.stopPrank();
    }

    /// @notice User-funded swap with fee-on-transfer compatibility enabled.
    /// @dev Uses `supportsFeeOnTransfer=true` to relax spending assertion in helper.
    function test_CanSwap_FeeOnTransferToken() public {
        vm.startPrank(RANDOM_APE_ETH_HOLDER_APECHAIN);

        // Build route for algebra swap with command code 2 (user funds)
        bytes memory swapData = _buildAlgebraSwapData(
            AlgebraRouteParams({
                commandCode: CommandType.DistributeUserERC20,
                tokenIn: address(tokenIn),
                destinationAddress: RANDOM_APE_ETH_HOLDER_APECHAIN,
                pool: poolInOut,
                supportsFeeOnTransfer: true
            })
        );

        _buildRouteAndExecuteAndVerifySwap(
            SwapTestParams({
                tokenIn: address(tokenIn),
                tokenOut: address(tokenOut),
                amountIn: _getDefaultAmountForTokenIn(),
                minOut: 0,
                sender: RANDOM_APE_ETH_HOLDER_APECHAIN,
                destinationAddress: RANDOM_APE_ETH_HOLDER_APECHAIN,
                commandType: CommandType.DistributeUserERC20
            }),
            swapData,
            new ExpectedEvent[](0),
            true // This is a fee-on-transfer token,
        );

        vm.stopPrank();
    }

    /// @notice User-funded single-hop swap on Algebra (forward direction).
    /// @dev Transfers funds from whale to user and executes swap to same user; enables fee on transfer support.
    function test_CanSwap() public override {
        vm.startPrank(RANDOM_APE_ETH_HOLDER_APECHAIN);

        // Transfer tokens from whale to USER_SENDER
        uint256 amountToTransfer = _getDefaultAmountForTokenIn();
        IERC20(tokenIn).transfer(USER_SENDER, amountToTransfer);

        vm.stopPrank();

        vm.startPrank(USER_SENDER);

        _testSwap(
            AlgebraSwapTestParams({
                from: USER_SENDER,
                destinationAddress: USER_SENDER,
                tokenIn: address(tokenIn),
                amountIn: _getDefaultAmountForTokenIn(),
                tokenOut: address(tokenOut),
                direction: SwapDirection.Token0ToToken1,
                supportsFeeOnTransfer: true
            })
        );

        vm.stopPrank();
    }

    /// @notice Reverse-direction swap roundtrip test to ensure pool works both ways.
    function test_CanSwap_Reverse() public {
        test_CanSwap();

        uint256 amountIn = IERC20(address(tokenOut)).balanceOf(USER_SENDER);

        vm.startPrank(USER_SENDER);

        _testSwap(
            AlgebraSwapTestParams({
                from: USER_SENDER,
                destinationAddress: USER_SENDER,
                tokenIn: address(tokenOut),
                amountIn: amountIn,
                tokenOut: address(tokenIn),
                direction: SwapDirection.Token1ToToken0,
                supportsFeeOnTransfer: false
            })
        );

        vm.stopPrank();
    }

    /// @notice Multi-hop user->aggregator swap with fee-on-transfer on middle token.
    /// @dev Constructs two pools locally, adds liquidity, and executes:
    ///      - Hop1: user A->B to aggregator
    ///      - Hop2: aggregator B->C to user
    function test_CanSwap_MultiHop_WithFeeOnTransferToken() public {
        MultiHopTestState memory state;
        state.isFeeOnTransfer = true;

        // Setup tokens and pools
        state = _setupTokensAndPools(state);

        // Execute and verify swap
        _executeAndVerifyMultiHopSwap(state);
    }

    /// @notice Multi-hop user->aggregator swap with regular mid token (no fee).
    function test_CanSwap_MultiHop() public override {
        MultiHopTestState memory state;
        state.isFeeOnTransfer = false;

        // Setup tokens and pools
        state = _setupTokensAndPools(state);

        // Execute and verify swap
        _executeAndVerifyMultiHopSwap(state);
    }

    /// @notice Ensures swap reverts if Algebra callback is never invoked by the pool.
    /// @dev Deploys a no-callback mock pool and verifies `SwapCallbackNotExecuted`.
    function testRevert_SwapWithoutCallback() public override {
        // Pool that does not call back for Algebra
        address mockPool = _deployNoCallbackPool(); // your Algebra-specific or shared mock

        // Fund user from whale instead of deal()
        vm.prank(RANDOM_APE_ETH_HOLDER_APECHAIN);
        IERC20(address(tokenIn)).transfer(
            USER_SENDER,
            _getDefaultAmountForTokenIn()
        );

        vm.startPrank(USER_SENDER);

        bytes memory swapData = _buildCallbackSwapData(mockPool, USER_SENDER);

        _buildRouteAndExecuteAndVerifySwap(
            SwapTestParams({
                tokenIn: address(tokenIn),
                tokenOut: address(tokenOut),
                amountIn: _getDefaultAmountForTokenIn(),
                minOut: 0,
                sender: USER_SENDER,
                destinationAddress: USER_SENDER,
                commandType: CommandType.DistributeUserERC20
            }),
            swapData,
            SwapCallbackNotExecuted.selector
        );

        vm.stopPrank();
    }

    /// @notice Validates revert when pool is zero address in swap data.
    function testRevert_AlgebraSwap_ZeroAddressPool() public {
        // Transfer tokens from whale to user
        vm.prank(RANDOM_APE_ETH_HOLDER_APECHAIN);
        IERC20(tokenIn).transfer(USER_SENDER, 1 * 1e18);

        vm.startPrank(USER_SENDER);

        // Mock token0() call on address(0)
        vm.mockCall(
            address(0),
            abi.encodeWithSelector(IAlgebraPool.token0.selector),
            abi.encode(tokenIn)
        );

        // Build route with address(0) as pool
        bytes memory swapData = _buildAlgebraSwapData(
            AlgebraRouteParams({
                commandCode: CommandType.DistributeUserERC20,
                tokenIn: address(tokenIn),
                destinationAddress: USER_SENDER,
                pool: address(0), // Zero address pool
                supportsFeeOnTransfer: true
            })
        );

        _buildRouteAndExecuteAndVerifySwap(
            SwapTestParams({
                tokenIn: address(tokenIn),
                tokenOut: address(tokenOut),
                amountIn: _getDefaultAmountForTokenIn(),
                minOut: 0,
                sender: USER_SENDER,
                destinationAddress: USER_SENDER,
                commandType: CommandType.DistributeUserERC20
            }),
            swapData,
            InvalidCallData.selector
        );

        vm.stopPrank();
        vm.clearMockedCalls();
    }

    // ==== Overrides ====

    /// @notice Returns Algebra-specific callback selector for the base callback tests.
    function _getCallbackSelector() internal view override returns (bytes4) {
        return algebraFacet.algebraSwapCallback.selector;
    }

    /// @notice Hook: build Algebra swap data [pool, direction(uint8), destinationAddress, supportsFeeOnTransfer(uint8)]
    /// @param pool Pool to be used for callback arming tests.
    /// @param destinationAddress Destination address.
    /// @return swapData Packed bytes starting with `swapAlgebra` selector.
    function _buildCallbackSwapData(
        address pool,
        address destinationAddress
    ) internal pure override returns (bytes memory) {
        return
            abi.encodePacked(
                AlgebraFacet.swapAlgebra.selector,
                pool,
                uint8(1), // Token0->Token1; only the callback arming/clearing is under test
                destinationAddress,
                uint8(0) // no fee-on-transfer
            );
    }

    /// @notice Validates revert when destinationAddress is zero address in swap data.
    function testRevert_AlgebraSwap_ZeroAddressDestinationAddress() public {
        // Transfer tokens from whale to user
        vm.prank(RANDOM_APE_ETH_HOLDER_APECHAIN);
        IERC20(tokenIn).transfer(USER_SENDER, 1 * 1e18);

        vm.startPrank(USER_SENDER);

        // Mock token0() call on the pool
        vm.mockCall(
            poolInOut,
            abi.encodeWithSelector(IAlgebraPool.token0.selector),
            abi.encode(tokenIn)
        );

        // Build route with address(0) as destination address
        bytes memory swapData = _buildAlgebraSwapData(
            AlgebraRouteParams({
                commandCode: CommandType.DistributeUserERC20,
                tokenIn: address(tokenIn),
                destinationAddress: address(0), // Zero address destination address
                pool: poolInOut,
                supportsFeeOnTransfer: true
            })
        );

        SwapTestParams memory params = SwapTestParams({
            tokenIn: address(tokenIn),
            tokenOut: address(tokenOut),
            amountIn: _getDefaultAmountForTokenIn(),
            minOut: 0,
            sender: USER_SENDER,
            destinationAddress: USER_SENDER,
            commandType: CommandType.DistributeUserERC20
        });

        _buildRouteAndExecuteAndVerifySwap(
            params,
            swapData,
            InvalidCallData.selector
        );

        vm.stopPrank();
        vm.clearMockedCalls();
    }

    // ==== Helper Functions ====

    /// @notice Creates 2 local Algebra pools and seeds liquidity for multi-hop tests.
    /// @param state Preallocated struct; `isFeeOnTransfer` toggles mid token behavior.
    /// @return Updated state with tokens/pools and funding applied.
    function _setupTokensAndPools(
        MultiHopTestState memory state
    ) private returns (MultiHopTestState memory) {
        // Create tokens
        ERC20 tokenA = new ERC20(
            "Token A",
            state.isFeeOnTransfer ? "FTA" : "TA",
            18
        );
        IERC20 tokenB;
        ERC20 tokenC = new ERC20(
            "Token C",
            state.isFeeOnTransfer ? "FTC" : "TC",
            18
        );

        if (state.isFeeOnTransfer) {
            tokenB = IERC20(
                address(
                    new MockFeeOnTransferToken("Fee Token B", "FTB", 18, 300)
                )
            );
        } else {
            tokenB = IERC20(address(new ERC20("Token B", "TB", 18)));
        }

        state.tokenA = IERC20(address(tokenA));
        state.tokenB = tokenB;
        state.tokenC = IERC20(address(tokenC));

        // Label addresses
        vm.label(address(state.tokenA), "Token A");
        vm.label(address(state.tokenB), "Token B");
        vm.label(address(state.tokenC), "Token C");

        // Mint initial token supplies
        tokenA.mint(address(this), 1_000_000 * 1e18);
        if (!state.isFeeOnTransfer) {
            ERC20(address(tokenB)).mint(address(this), 1_000_000 * 1e18);
        } else {
            MockFeeOnTransferToken(address(tokenB)).mint(
                address(this),
                1_000_000 * 1e18
            );
        }
        tokenC.mint(address(this), 1_000_000 * 1e18);

        // Create pools
        state.pool1 = _createAlgebraPool(
            address(state.tokenA),
            address(state.tokenB)
        );
        state.pool2 = _createAlgebraPool(
            address(state.tokenB),
            address(state.tokenC)
        );

        vm.label(state.pool1, "Pool 1");
        vm.label(state.pool2, "Pool 2");

        // Add liquidity
        _addLiquidityToPool(
            state.pool1,
            address(state.tokenA),
            address(state.tokenB)
        );
        _addLiquidityToPool(
            state.pool2,
            address(state.tokenB),
            address(state.tokenC)
        );

        state.amountToTransfer = 100 * 1e18;
        state.amountIn = 50 * 1e18;

        // Transfer tokens to USER_SENDER
        IERC20(address(state.tokenA)).transfer(
            USER_SENDER,
            state.amountToTransfer
        );

        return state;
    }

    /// @notice Executes a two-hop route A->B (user) then B->C (aggregator).
    /// @param state Prepared state from `_setupTokensAndPools`.
    function _executeAndVerifyMultiHopSwap(
        MultiHopTestState memory state
    ) private {
        vm.startPrank(USER_SENDER);

        // Build route and execute swap
        SwapTestParams[] memory swapParams = new SwapTestParams[](2);
        bytes[] memory swapData = new bytes[](2);

        // First hop: TokenA -> TokenB
        swapParams[0] = SwapTestParams({
            tokenIn: address(state.tokenA),
            tokenOut: address(state.tokenB),
            amountIn: state.amountIn,
            minOut: 0,
            sender: USER_SENDER,
            destinationAddress: address(ldaDiamond), // Send to aggregator for next hop
            commandType: CommandType.DistributeUserERC20
        });

        // Build first hop swap data
        swapData[0] = _buildAlgebraSwapData(
            AlgebraRouteParams({
                commandCode: CommandType.DistributeUserERC20,
                tokenIn: address(state.tokenA),
                destinationAddress: address(ldaDiamond),
                pool: state.pool1,
                supportsFeeOnTransfer: false
            })
        );

        // Second hop: TokenB -> TokenC
        swapParams[1] = SwapTestParams({
            tokenIn: address(state.tokenB),
            tokenOut: address(state.tokenC),
            amountIn: 0, // Not used for DistributeSelfERC20
            minOut: 0,
            sender: address(ldaDiamond),
            destinationAddress: USER_SENDER,
            commandType: CommandType.DistributeSelfERC20
        });

        // Build second hop swap data
        swapData[1] = _buildAlgebraSwapData(
            AlgebraRouteParams({
                commandCode: CommandType.DistributeSelfERC20,
                tokenIn: address(state.tokenB),
                destinationAddress: USER_SENDER,
                pool: state.pool2,
                supportsFeeOnTransfer: state.isFeeOnTransfer
            })
        );

        bytes memory route = _buildMultiHopRoute(swapParams, swapData);

        _executeAndVerifySwap(
            SwapTestParams({
                tokenIn: address(state.tokenA),
                tokenOut: address(state.tokenC),
                amountIn: state.amountIn,
                minOut: 0,
                sender: USER_SENDER,
                destinationAddress: USER_SENDER,
                commandType: CommandType.DistributeUserERC20
            }),
            route
        );

        vm.stopPrank();
    }

    /// @notice Creates an Algebra pool via on-chain factory (fork path).
    /// @param tokenA First token.
    /// @param tokenB Second token.
    /// @return pool New pool address.
    function _createAlgebraPool(
        address tokenA,
        address tokenB
    ) internal returns (address pool) {
        // Call the actual Algebra factory to create a pool
        pool = IAlgebraFactory(ALGEBRA_FACTORY_APECHAIN).createPool(
            tokenA,
            tokenB
        );
        return pool;
    }

    /// @notice Adds liquidity to the given Algebra pool using available token balances.
    /// @param pool Pool to seed.
    /// @param token0 token0 address.
    /// @param token1 token1 address.
    /// @dev Uses a helper that safely tolerates fee-on-transfer behavior.
    function _addLiquidityToPool(
        address pool,
        address token0,
        address token1
    ) internal {
        // For fee-on-transfer tokens, we need to send more  to account for the fee
        // We'll use a small amount and send extra to cover fees
        uint256 initialAmount0 = 1e17; // 0.1 token
        uint256 initialAmount1 = 1e17; // 0.1 token

        // Send extra for fee-on-transfer tokens (10% extra should be enough for our test tokens with 5% fee)
        uint256 transferAmount0 = (initialAmount0 * 110) / 100;
        uint256 transferAmount1 = (initialAmount1 * 110) / 100;

        // Initialize with 1:1 price ratio (Q64.96 format)
        uint160 initialPrice = uint160(1 << 96);
        IAlgebraPool(pool).initialize(initialPrice);

        // Create AlgebraLiquidityAdderHelper with safe transfer logic
        AlgebraLiquidityAdderHelper algebraLiquidityAdderHelper = new AlgebraLiquidityAdderHelper(
                token0,
                token1
            );

        // Transfer tokens with extra amounts to account for fees
        IERC20(token0).transfer(
            address(algebraLiquidityAdderHelper),
            transferAmount0
        );
        IERC20(token1).transfer(
            address(algebraLiquidityAdderHelper),
            transferAmount1
        );

        // Get actual balances to use for liquidity, accounting for any fees
        uint256 actualBalance0 = IERC20(token0).balanceOf(
            address(algebraLiquidityAdderHelper)
        );
        uint256 actualBalance1 = IERC20(token1).balanceOf(
            address(algebraLiquidityAdderHelper)
        );

        // Use the smaller of the two balances for liquidity amount
        uint128 liquidityAmount = uint128(
            actualBalance0 < actualBalance1 ? actualBalance0 : actualBalance1
        );

        // Add liquidity using the actual token amounts we have
        algebraLiquidityAdderHelper.addLiquidity(
            pool,
            -887220,
            887220,
            liquidityAmount / 2 // Use half of available liquidity to ensure success
        );
    }

    /// @notice Builds Algebra swap data payload for a hop.
    /// @param params Route parameters used to determine direction and toggle fee on transfer token support.
    /// @return Packed bytes for `swapAlgebra`.
    function _buildAlgebraSwapData(
        AlgebraRouteParams memory params
    ) private view returns (bytes memory) {
        address token0 = IAlgebraPool(params.pool).token0();
        bool zeroForOne = (params.tokenIn == token0);
        SwapDirection direction = zeroForOne
            ? SwapDirection.Token0ToToken1
            : SwapDirection.Token1ToToken0;

        // This data blob is what the AlgebraFacet will receive and parse
        return
            abi.encodePacked(
                AlgebraFacet.swapAlgebra.selector,
                params.pool,
                uint8(direction),
                params.destinationAddress,
                params.supportsFeeOnTransfer ? uint8(1) : uint8(0)
            );
    }

    /// @notice High-level helper that performs a fork-based Algebra swap and verifies balances.
    /// @param params See `AlgebraSwapTestParams`.
    /// @dev Uses QuoterV2 to get expectedOut and sets minOut = expected - 1 for tolerance.
    function _testSwap(AlgebraSwapTestParams memory params) internal {
        // Find or create a pool
        address pool = _getPool(params.tokenIn, params.tokenOut);

        // Get expected output from QuoterV2
        uint256 expectedOutput = _getQuoteExactInput(
            params.tokenIn,
            params.tokenOut,
            params.amountIn
        );

        // Add 1 wei slippage buffer
        uint256 minOutput = expectedOutput > 0 ? expectedOutput - 1 : 0;

        // if tokens come from the aggregator (address(ldaDiamond)), use command code 1; otherwise, use 2.
        CommandType commandCode = params.from == address(ldaDiamond)
            ? CommandType.DistributeSelfERC20
            : CommandType.DistributeUserERC20;

        // Pack the specific data for this swap
        bytes memory swapData = _buildAlgebraSwapData(
            AlgebraRouteParams({
                commandCode: commandCode,
                tokenIn: params.tokenIn,
                destinationAddress: params.destinationAddress,
                pool: pool,
                supportsFeeOnTransfer: params.supportsFeeOnTransfer
            })
        );

        // Build route with minOutput that includes slippage buffer
        bytes memory route = _buildBaseRoute(
            SwapTestParams({
                tokenIn: params.tokenIn,
                tokenOut: params.tokenOut,
                amountIn: params.amountIn,
                minOut: minOutput,
                sender: params.from,
                destinationAddress: params.destinationAddress,
                commandType: commandCode
            }),
            swapData
        );

        _executeAndVerifySwap(
            SwapTestParams({
                tokenIn: params.tokenIn,
                tokenOut: params.tokenOut,
                amountIn: params.amountIn,
                minOut: minOutput,
                sender: params.from,
                destinationAddress: params.destinationAddress,
                commandType: params.from == address(ldaDiamond)
                    ? CommandType.DistributeSelfERC20
                    : CommandType.DistributeUserERC20
            }),
            route,
            new ExpectedEvent[](0),
            params.supportsFeeOnTransfer
        );
    }

    /// @notice Resolves pool by pair via router/factory and reverts if missing.
    /// @param tokenA First token.
    /// @param tokenB Second token.
    /// @return pool Pool address.
    function _getPool(
        address tokenA,
        address tokenB
    ) private view returns (address pool) {
        pool = IAlgebraRouter(ALGEBRA_FACTORY_APECHAIN).poolByPair(
            tokenA,
            tokenB
        );
        if (pool == address(0)) revert PoolDoesNotExist();
        return pool;
    }

    /// @notice Quotes expected output using Algebra QuoterV2 for exactInputSingle.
    /// @param tokenIn Input token.
    /// @param tokenOut Output token.
    /// @param amountIn Input amount.
    /// @return amountOut Quote for amount out.
    function _getQuoteExactInput(
        address tokenIn,
        address tokenOut,
        uint256 amountIn
    ) private returns (uint256 amountOut) {
        (amountOut, ) = IAlgebraQuoter(ALGEBRA_QUOTER_V2_APECHAIN)
            .quoteExactInputSingle(tokenIn, tokenOut, amountIn, 0);
        return amountOut;
    }
}

/// @title AlgebraLiquidityAdderHelper
/// @notice Adds liquidity to an Algebra pool using balances available on this helper.
/// @dev Implements `algebraMintCallback` to transfer owed amounts to the pool.
contract AlgebraLiquidityAdderHelper {
    error Token0TransferFailed();
    error Token1TransferFailed();

    /// @notice token0 used by the target pool.
    address public immutable TOKEN_0;
    /// @notice token1 used by the target pool.
    address public immutable TOKEN_1;

    /// @notice Sets immutable token references.
    /// @param _token0 token0 address.
    /// @param _token1 token1 address.
    constructor(address _token0, address _token1) {
        TOKEN_0 = _token0;
        TOKEN_1 = _token1;
    }

    // ==== External Functions ====

    /// @notice Adds liquidity by calling Algebra pool `mint` and returning actual spend.
    /// @param pool Pool address.
    /// @param bottomTick Lower tick.
    /// @param topTick Upper tick.
    /// @param amount Desired liquidity amount.
    /// @return amount0 Actual token0 spent.
    /// @return amount1 Actual token1 spent.
    /// @return liquidityActual Actual liquidity minted.
    function addLiquidity(
        address pool,
        int24 bottomTick,
        int24 topTick,
        uint128 amount
    )
        external
        returns (uint256 amount0, uint256 amount1, uint128 liquidityActual)
    {
        // Get balances before
        uint256 balance0Before = IERC20(TOKEN_0).balanceOf(address(this));
        uint256 balance1Before = IERC20(TOKEN_1).balanceOf(address(this));

        // Call mint
        (amount0, amount1, liquidityActual) = IAlgebraPool(pool).mint(
            address(this),
            address(this),
            bottomTick,
            topTick,
            amount,
            abi.encode(TOKEN_0, TOKEN_1)
        );

        // Get balances after to account for fees
        uint256 balance0After = IERC20(TOKEN_0).balanceOf(address(this));
        uint256 balance1After = IERC20(TOKEN_1).balanceOf(address(this));

        // Calculate actual amounts transferred accounting for fees
        amount0 = balance0Before - balance0After;
        amount1 = balance1Before - balance1After;

        return (amount0, amount1, liquidityActual);
    }

    /// @notice Callback invoked by Algebra pool to collect owed tokens during mint.
    /// @param amount0Owed Owed token0.
    /// @param amount1Owed Owed token1.
    /// @dev Transfers up to current balance for each owed amount and ensures non-zero effect.
    function algebraMintCallback(
        uint256 amount0Owed,
        uint256 amount1Owed,
        bytes calldata
    ) external {
        // Check token balances
        uint256 balance0 = IERC20(TOKEN_0).balanceOf(address(this));
        uint256 balance1 = IERC20(TOKEN_1).balanceOf(address(this));

        // Transfer what we can, limited by actual balance
        if (amount0Owed > 0) {
            uint256 amount0ToSend = amount0Owed > balance0
                ? balance0
                : amount0Owed;
            uint256 balance0Before = IERC20(TOKEN_0).balanceOf(
                address(msg.sender)
            );
            IERC20(TOKEN_0).transfer(msg.sender, amount0ToSend);
            uint256 balance0After = IERC20(TOKEN_0).balanceOf(
                address(msg.sender)
            );
            if (balance0After <= balance0Before) revert Token0TransferFailed();
        }

        if (amount1Owed > 0) {
            uint256 amount1ToSend = amount1Owed > balance1
                ? balance1
                : amount1Owed;
            uint256 balance1Before = IERC20(TOKEN_1).balanceOf(
                address(msg.sender)
            );
            IERC20(TOKEN_1).transfer(msg.sender, amount1ToSend);
            uint256 balance1After = IERC20(TOKEN_1).balanceOf(
                address(msg.sender)
            );
            if (balance1After <= balance1Before) revert Token1TransferFailed();
        }
    }
}
