// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.17;

import { Test } from "forge-std/Test.sol";
import { DSTest } from "ds-test/test.sol";
import { ILiFi } from "lifi/Interfaces/ILiFi.sol";
import { LibSwap } from "lifi/Libraries/LibSwap.sol";
import { UniswapV2Router02 } from "../utils/Interfaces.sol";
import { DiamondTest, LiFiDiamond } from "../utils/DiamondTest.sol";
import { ERC20 } from "solmate/tokens/ERC20.sol";
import { LibAllowList } from "lifi/Libraries/LibAllowList.sol";
import { FeeCollector } from "lifi/Periphery/FeeCollector.sol";
import { NativeAssetTransferFailed, ReentrancyError } from "src/Errors/GenericErrors.sol";
import { stdJson } from "forge-std/StdJson.sol";

using stdJson for string;

contract TestFacet {
    constructor() {}

    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract ReentrancyChecker is DSTest {
    address private _facetAddress;
    bytes private _callData;

    error InitialCallFailed(bytes data);
    error ReentrantCallFailed(bytes data);

    constructor(address facetAddress) {
        _facetAddress = facetAddress;
        ERC20(0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48).approve(
            _facetAddress,
            type(uint256).max
        ); // approve USDC max to facet
        ERC20(0x6B175474E89094C44Da98b954EedeAC495271d0F).approve(
            _facetAddress,
            type(uint256).max
        ); // approve DAI max to facet
    }

    // must be called with abi.encodePacked(selector, someParam)
    // selector = function selector of the to-be-checked function
    // someParam = valid arguments for the function call
    function callFacet(bytes calldata callData) public {
        _callData = callData;
        (bool success, bytes memory data) = _facetAddress.call{
            value: 10 ether
        }(callData);
        if (!success) {
            if (
                keccak256(data) ==
                keccak256(abi.encodePacked(NativeAssetTransferFailed.selector))
            ) {
                revert ReentrancyError();
            } else {
                revert InitialCallFailed(data);
            }
        }
    }

    receive() external payable {
        _handleReceive();
    }

    function _handleReceive() internal {
        (bool success, bytes memory data) = _facetAddress.call{
            value: 10 ether
        }(_callData);
        if (!success) {
            if (
                keccak256(data) ==
                keccak256(abi.encodePacked(ReentrancyError.selector))
            ) {
                revert ReentrancyError();
            } else {
                revert ReentrantCallFailed(data);
            }
        }
    }
}

//common utilities for forge tests
// solhint-disable max-states-count
abstract contract TestBase is Test, DiamondTest, ILiFi {
    address internal _facetTestContractAddress;
    uint64 internal currentTxId;
    bytes32 internal nextUser = keccak256(abi.encodePacked("user address"));
    UniswapV2Router02 internal uniswap;
    ERC20 internal usdc;
    ERC20 internal usdt;
    ERC20 internal dai;
    ERC20 internal weth;
    LiFiDiamond internal diamond;
    FeeCollector internal feeCollector;
    ILiFi.BridgeData internal bridgeData;
    LibSwap.SwapData[] internal swapData;
    uint256 internal defaultDAIAmount;
    uint256 internal defaultUSDCAmount;
    uint256 internal defaultNativeAmount;
    // tokenAddress => userAddress => balance
    mapping(address => mapping(address => uint256)) internal initialBalances;
    uint256 internal addToMessageValue;
    // set these custom values in your test file to
    uint256 internal customBlockNumberForForking;
    string internal customRpcUrlForForking;
    string internal logFilePath;

    // EVENTS
    event AssetSwapped(
        bytes32 transactionId,
        address dex,
        address fromAssetId,
        address toAssetId,
        uint256 fromAmount,
        uint256 toAmount,
        uint256 timestamp
    );
    event Transfer(address from, address to, uint256 amount);

    error NativeBridgeFailed();
    error ERC20BridgeFailed();

    // CONSTANTS
    // Forking
    uint256 internal constant DEFAULT_BLOCK_NUMBER_MAINNET = 15588208;

    // WALLET ADDRESSES (all networks)
    address internal constant REFUND_WALLET =
        0x317F8d18FB16E49a958Becd0EA72f8E153d25654;
    address internal constant WITHDRAW_WALLET =
        0x08647cc950813966142A416D40C382e2c5DB73bB;

    // Contract addresses (MAINNET)
    // solhint-disable var-name-mixedcase
    address internal ADDRESS_UNISWAP =
        0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D;
    // solhint-disable var-name-mixedcase
    address internal ADDRESS_USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    // solhint-disable var-name-mixedcase
    address internal ADDRESS_USDT = 0xdAC17F958D2ee523a2206206994597C13D831ec7;
    // solhint-disable var-name-mixedcase
    address internal ADDRESS_DAI = 0x6B175474E89094C44Da98b954EedeAC495271d0F;
    // solhint-disable var-name-mixedcase
    address internal ADDRESS_WRAPPED_NATIVE =
        0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    // Contract addresses (ARBITRUM)
    address internal constant ADDRESS_UNISWAP_ARB =
        0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24;
    address internal constant ADDRESS_SUSHISWAP_ARB =
        0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506;
    address internal constant ADDRESS_USDC_ARB =
        0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8;
    address internal constant ADDRESS_USDT_ARB =
        0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9;
    address internal constant ADDRESS_DAI_ARB =
        0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1;
    address internal constant ADDRESS_WRAPPED_NATIVE_ARB =
        0x82aF49447D8a07e3bd95BD0d56f35241523fBab1;
    // Contract addresses (POLYGON)
    address internal constant ADDRESS_UNISWAP_POL =
        0xedf6066a2b290C185783862C7F4776A2C8077AD1;
    address internal constant ADDRESS_SUSHISWAP_POL =
        0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506;
    address internal constant ADDRESS_USDC_POL =
        0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359; // Circle USDC, decimals: 6
    address internal constant ADDRESS_USDCE_POL =
        0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174; // USDC.e
    address internal constant ADDRESS_USDT_POL =
        0xc2132D05D31c914a87C6611C10748AEb04B58e8F;
    address internal constant ADDRESS_DAI_POL =
        0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063;
    address internal constant ADDRESS_WETH_POL =
        0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619;
    address internal constant ADDRESS_WRAPPED_NATIVE_POL =
        0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270; // WMATIC
    // Contract addresses (BASE)
    address internal constant ADDRESS_UNISWAP_BASE =
        0x6BDED42c6DA8FBf0d2bA55B2fa120C5e0c8D7891;
    address internal constant ADDRESS_USDC_BASE =
        0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address internal constant ADDRESS_USDT_BASE =
        0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2;
    address internal constant ADDRESS_DAI_BASE =
        0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb;
    address internal constant ADDRESS_WRAPPED_NATIVE_BASE =
        0x4200000000000000000000000000000000000006;
    // Contract addresses (OPTIMISM)
    address internal constant ADDRESS_UNISWAP_OPTIMISM =
        0x4A7b5Da61326A6379179b40d00F57E5bbDC962c2;
    address internal constant ADDRESS_USDC_OPTIMISM =
        0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85;
    address internal constant ADDRESS_USDT_OPTIMISM =
        0x94b008aA00579c1307B0EF2c499aD98a8ce58e58;
    address internal constant ADDRESS_DAI_OPTIMISM =
        0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1;
    address internal constant ADDRESS_WRAPPED_NATIVE_OPTIMISM =
        0x4200000000000000000000000000000000000006;
    // User accounts (Whales: ETH only)
    address internal constant USER_SENDER = address(0xabc123456); // initially funded with 100,000 DAI, USDC, USDT, WETH & ETHER
    address internal constant USER_RECEIVER = address(0xabc654321);
    address internal constant USER_REFUND = address(0xabcdef281);
    address internal constant USER_PAUSER = address(0xdeadbeef);
    address internal constant USER_DIAMOND_OWNER =
        0x5042255A3F3FD7727e419CeA387cAFDfad3C3aF8;
    address internal constant USER_USDC_WHALE =
        0x72A53cDBBcc1b9efa39c834A540550e23463AAcB;
    address internal constant USER_DAI_WHALE =
        0x4aa42145Aa6Ebf72e164C9bBC74fbD3788045016;
    address internal constant USER_WETH_WHALE =
        0xF04a5cC80B1E94C69B48f5ee68a08CD2F09A7c3E;

    // MODIFIERS

    //@dev token == address(0) => check balance of native token
    modifier assertBalanceChange(address token, address user, int256 amount) {
        // store initial balance
        if (token == address(0)) {
            initialBalances[token][user] = user.balance;
        } else {
            initialBalances[token][user] = ERC20(token).balanceOf(user);
        }

        //execute function
        _;

        //check post-execution balances
        uint256 currentBalance;
        if (token == address(0)) {
            currentBalance = user.balance;
        } else {
            currentBalance = ERC20(token).balanceOf(user);
        }
        uint256 expectedBalance = uint256(
            int256(initialBalances[token][user]) + amount
        );
        assertEq(currentBalance, expectedBalance);
    }

    function _overwriteAddressesForNonMainnetForks() internal {
        // check if a customRPCUrl exists (otherwise it's a mainnet fork)
        if (bytes(customRpcUrlForForking).length > 0) {
            if (
                keccak256(abi.encode(customRpcUrlForForking)) ==
                keccak256(abi.encode("ETH_NODE_URI_ARBITRUM"))
            ) {
                ADDRESS_USDC = ADDRESS_USDC_ARB;
                ADDRESS_USDT = ADDRESS_USDT_ARB;
                ADDRESS_DAI = ADDRESS_DAI_ARB;
                ADDRESS_WRAPPED_NATIVE = ADDRESS_WRAPPED_NATIVE_ARB;
                ADDRESS_UNISWAP = ADDRESS_SUSHISWAP_ARB;
            }
            if (
                keccak256(abi.encode(customRpcUrlForForking)) ==
                keccak256(abi.encode("ETH_NODE_URI_POLYGON"))
            ) {
                ADDRESS_USDC = ADDRESS_USDCE_POL;
                ADDRESS_USDT = ADDRESS_USDT_POL;
                ADDRESS_DAI = ADDRESS_DAI_POL;
                ADDRESS_WRAPPED_NATIVE = ADDRESS_WRAPPED_NATIVE_POL;
                ADDRESS_UNISWAP = ADDRESS_SUSHISWAP_POL;
            }
            if (
                keccak256(abi.encode(customRpcUrlForForking)) ==
                keccak256(abi.encode("ETH_NODE_URI_BASE"))
            ) {
                ADDRESS_USDC = ADDRESS_USDC_BASE;
                ADDRESS_USDT = ADDRESS_USDT_BASE;
                ADDRESS_DAI = ADDRESS_DAI_BASE;
                ADDRESS_WRAPPED_NATIVE = ADDRESS_WRAPPED_NATIVE_BASE;
                ADDRESS_UNISWAP = ADDRESS_UNISWAP_BASE;
            }
            if (
                keccak256(abi.encode(customRpcUrlForForking)) ==
                keccak256(abi.encode("ETH_NODE_URI_OPTIMISM"))
            ) {
                ADDRESS_USDC = ADDRESS_USDC_OPTIMISM;
                ADDRESS_USDT = ADDRESS_USDT_OPTIMISM;
                ADDRESS_DAI = ADDRESS_DAI_OPTIMISM;
                ADDRESS_WRAPPED_NATIVE = ADDRESS_WRAPPED_NATIVE_OPTIMISM;
                ADDRESS_UNISWAP = ADDRESS_UNISWAP_OPTIMISM;
            }
        }
    }

    // FUNCTIONS
    function initTestBase() internal {
        _overwriteAddressesForNonMainnetForks();
        // label addresses (for better readability in error traces)
        vm.label(USER_SENDER, "USER_SENDER");
        vm.label(USER_RECEIVER, "USER_RECEIVER");
        vm.label(USER_REFUND, "USER_REFUND");
        vm.label(USER_PAUSER, "USER_PAUSER");
        vm.label(USER_DIAMOND_OWNER, "USER_DIAMOND_OWNER");
        vm.label(USER_USDC_WHALE, "USER_USDC_WHALE");
        vm.label(USER_WETH_WHALE, "USER_DAI_WHALE");
        vm.label(ADDRESS_USDC, "ADDRESS_USDC_PROXY");
        vm.label(
            0xa2327a938Febf5FEC13baCFb16Ae10EcBc4cbDCF,
            "ADDRESS_USDC_IMPL"
        );
        vm.label(ADDRESS_DAI, "ADDRESS_DAI");
        vm.label(ADDRESS_USDT, "ADDRESS_USDT");
        vm.label(ADDRESS_UNISWAP, "ADDRESS_UNISWAP");
        vm.label(ADDRESS_WRAPPED_NATIVE, "ADDRESS_WRAPPED_NATIVE");

        // activate fork
        fork();

        // fill user accounts with starting balance
        uniswap = UniswapV2Router02(ADDRESS_UNISWAP);
        usdc = ERC20(ADDRESS_USDC);
        usdt = ERC20(ADDRESS_USDT);
        dai = ERC20(ADDRESS_DAI);
        weth = ERC20(ADDRESS_WRAPPED_NATIVE);

        // deploy & configure diamond
        diamond = createDiamond(USER_DIAMOND_OWNER, USER_PAUSER);

        // deploy feeCollector
        feeCollector = new FeeCollector(USER_DIAMOND_OWNER);

        // transfer initial DAI/USDC/USDT/WETH balance to USER_SENDER
        deal(ADDRESS_USDC, USER_SENDER, 100_000 * 10 ** usdc.decimals());
        deal(ADDRESS_USDT, USER_SENDER, 100_000 * 10 ** usdt.decimals());
        deal(ADDRESS_DAI, USER_SENDER, 100_000 * 10 ** dai.decimals());
        deal(
            ADDRESS_WRAPPED_NATIVE,
            USER_SENDER,
            100_000 * 10 ** weth.decimals()
        );

        // fund USER_SENDER with 1000 ether
        vm.deal(USER_SENDER, 1000 ether);

        // initiate variables
        defaultDAIAmount = 100 * 10 ** dai.decimals();
        defaultUSDCAmount = 100 * 10 ** usdc.decimals();
        defaultNativeAmount = 1 ether;

        // set path for logfile (esp. interesting for fuzzing tests)
        logFilePath = "./test/logs/";
        vm.writeFile(
            logFilePath,
            string.concat(
                "\n Logfile created at timestamp: ",
                string.concat(vm.toString(block.timestamp), "\n")
            )
        );

        setDefaultBridgeData();
    }

    function setFacetAddressInTestBase(
        address facetAddress,
        string memory facetName
    ) internal {
        _facetTestContractAddress = facetAddress;
        setDefaultSwapDataSingleDAItoUSDC();
        vm.label(facetAddress, facetName);
    }

    function fork() internal virtual {
        string memory rpcUrl = bytes(customRpcUrlForForking).length > 0
            ? vm.envString(customRpcUrlForForking)
            : vm.envString("ETH_NODE_URI_MAINNET");
        uint256 blockNumber = customBlockNumberForForking > 0
            ? customBlockNumberForForking
            : 14847528;

        vm.createSelectFork(rpcUrl, blockNumber);
    }

    function setDefaultBridgeData() internal {
        bridgeData = ILiFi.BridgeData({
            transactionId: "",
            bridge: "<UpdateWithYourBridgeName>",
            integrator: "",
            referrer: address(0),
            sendingAssetId: ADDRESS_USDC,
            receiver: USER_RECEIVER,
            minAmount: defaultUSDCAmount,
            destinationChainId: 137,
            hasSourceSwaps: false,
            hasDestinationCall: false
        });
    }

    //@dev: be careful that _facetTestContractAddress is set before calling this function
    function setDefaultSwapDataSingleDAItoUSDC() internal virtual {
        delete swapData;
        // Swap DAI -> USDC
        address[] memory path = new address[](2);
        path[0] = ADDRESS_DAI;
        path[1] = ADDRESS_USDC;

        uint256 amountOut = defaultUSDCAmount;

        // Calculate DAI amount
        uint256[] memory amounts = uniswap.getAmountsIn(amountOut, path);
        uint256 amountIn = amounts[0];

        swapData.push(
            LibSwap.SwapData({
                callTo: address(uniswap),
                approveTo: address(uniswap),
                sendingAssetId: ADDRESS_DAI,
                receivingAssetId: ADDRESS_USDC,
                fromAmount: amountIn,
                callData: abi.encodeWithSelector(
                    uniswap.swapExactTokensForTokens.selector,
                    amountIn,
                    amountOut,
                    path,
                    _facetTestContractAddress,
                    block.timestamp + 20 minutes
                ),
                requiresDeposit: true
            })
        );
    }

    // @dev: be careful that _facetTestContractAddress is set before calling this function
    function setDefaultSwapDataSingleETHtoUSDC() internal virtual {
        delete swapData;
        // Swap ETH -> USDC
        address[] memory path = new address[](2);
        path[0] = ADDRESS_WRAPPED_NATIVE;
        path[1] = ADDRESS_USDC;

        uint256 amountOut = defaultUSDCAmount;

        // Calculate DAI amount
        uint256[] memory amounts = uniswap.getAmountsIn(amountOut, path);
        uint256 amountIn = amounts[0];

        swapData.push(
            LibSwap.SwapData({
                callTo: address(uniswap),
                approveTo: address(uniswap),
                sendingAssetId: address(0),
                receivingAssetId: ADDRESS_USDC,
                fromAmount: amountIn,
                callData: abi.encodeWithSelector(
                    uniswap.swapExactETHForTokens.selector,
                    amountOut,
                    path,
                    _facetTestContractAddress,
                    block.timestamp + 20 minutes
                ),
                requiresDeposit: true
            })
        );
    }

    //@dev: be careful that _facetTestContractAddress is set before calling this function
    function setDefaultSwapDataSingleDAItoETH() internal virtual {
        delete swapData;
        // Swap DAI -> ETH
        address[] memory path = new address[](2);
        path[0] = ADDRESS_DAI;
        path[1] = ADDRESS_WRAPPED_NATIVE;

        uint256 amountOut = 1 ether;

        // Calculate DAI amount
        uint256[] memory amounts = uniswap.getAmountsIn(amountOut, path);
        uint256 amountIn = amounts[0];

        swapData.push(
            LibSwap.SwapData({
                callTo: address(uniswap),
                approveTo: address(uniswap),
                sendingAssetId: ADDRESS_DAI,
                receivingAssetId: address(0),
                fromAmount: amountIn,
                callData: abi.encodeWithSelector(
                    uniswap.swapTokensForExactETH.selector,
                    amountOut,
                    amountIn,
                    path,
                    _facetTestContractAddress,
                    block.timestamp + 20 minutes
                ),
                requiresDeposit: true
            })
        );
    }

    function addLiquidity(
        address tokenA,
        address tokenB,
        uint256 amountADesired,
        uint256 amountBDesired
    ) internal returns (uint256 amountA, uint256 amountB, uint256 liquidity) {
        deal(tokenA, address(this), amountADesired);
        deal(tokenB, address(this), amountBDesired);

        ERC20(tokenA).approve(address(uniswap), amountADesired);
        ERC20(tokenB).approve(address(uniswap), amountBDesired);

        (amountA, amountB, liquidity) = uniswap.addLiquidity(
            tokenA,
            tokenB,
            amountADesired,
            amountBDesired,
            0,
            0,
            address(this),
            block.timestamp
        );

        return (amountA, amountB, liquidity);
    }

    //#region Utility Functions (may be used in tests)

    function log_bool(string memory key, bool val) internal {
        emit log_named_string(key, val ? "true" : "false");
    }

    function printBridgeData(ILiFi.BridgeData memory _bridgeData) internal {
        emit log_named_bytes32(
            "transactionId               ",
            _bridgeData.transactionId
        );
        emit log_named_string(
            "bridge                      ",
            _bridgeData.bridge
        );
        emit log_named_string(
            "integrator                  ",
            _bridgeData.integrator
        );
        emit log_named_address(
            "referrer                    ",
            _bridgeData.referrer
        );
        emit log_named_address(
            "sendingAssetId              ",
            _bridgeData.sendingAssetId
        );
        emit log_named_address(
            "receiver                    ",
            _bridgeData.receiver
        );
        emit log_named_uint(
            "minAmount                   ",
            _bridgeData.minAmount
        );
        emit log_named_uint(
            "destinationChainId          ",
            _bridgeData.destinationChainId
        );
        log_bool("hasSourceSwaps          ", _bridgeData.hasSourceSwaps);
        log_bool(
            "hasDestinationCall          ",
            _bridgeData.hasDestinationCall
        );
    }

    function fuelAccountWithERC20(
        address tokenAddress,
        address to,
        address tokenWhale,
        uint256 amount
    ) internal {
        vm.startPrank(tokenWhale);
        ERC20(tokenAddress).transfer(to, amount);
        vm.stopPrank();
    }

    //#endregion

    //#region existing functions of utilities.sol
    function getNextUserAddress() external returns (address payable) {
        //bytes32 to address conversion
        address payable user = payable(address(uint160(uint256(nextUser))));
        nextUser = keccak256(abi.encodePacked(nextUser));
        return user;
    }

    //create users with 100 ether balance
    function createUsers(
        uint256 userNum
    ) external returns (address payable[] memory) {
        address payable[] memory users = new address payable[](userNum);
        for (uint256 i = 0; i < userNum; i++) {
            address payable user = this.getNextUserAddress();
            vm.deal(user, 100 ether);
            users[i] = user;
        }
        return users;
    }

    //move block.number forward by a given number of blocks
    function mineBlocks(uint256 numBlocks) external {
        uint256 targetBlock = block.number + numBlocks;
        vm.roll(targetBlock);
    }

    function getConfigAddressFromPath(
        string memory configFileName,
        string memory jsonPath
    ) internal returns (address) {
        string memory path = string.concat(
            vm.projectRoot(),
            "/config/",
            configFileName
        );
        string memory json = vm.readFile(path);
        return json.readAddress(jsonPath);
    }
    //#endregion
}
