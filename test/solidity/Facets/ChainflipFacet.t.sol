// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { LibAllowList, TestBaseFacet, console, ERC20 } from "../utils/TestBaseFacet.sol";
import { ChainflipFacet } from "lifi/Facets/ChainflipFacet.sol";
import { LibAsset } from "lifi/Libraries/LibAsset.sol";
import { LibSwap } from "lifi/Libraries/LibSwap.sol";
import { stdJson } from "forge-std/StdJson.sol";

using stdJson for string;

// Stub ChainflipFacet Contract
contract TestChainflipFacet is ChainflipFacet {
    constructor(address _chainflipVault) ChainflipFacet(_chainflipVault) {}

    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract ChainflipFacetTest is TestBaseFacet {
    ChainflipFacet.ChainflipData internal validChainflipData;
    TestChainflipFacet internal chainflipFacet;
    address internal CHAINFLIP_VAULT;

    uint256 internal constant CHAIN_ID_ETHEREUM = 1;
    uint256 internal constant CHAIN_ID_ARBITRUM = 42161;
    uint256 internal constant CHAIN_ID_SOLANA = 1151111081099710;
    uint256 internal constant CHAIN_ID_BITCOIN = 20000000000001;

    function setUp() public {
        customBlockNumberForForking = 18277082;
        initTestBase();

        // Read chainflip vault address from config
        string memory path = string.concat(
            vm.projectRoot(),
            "/config/chainflip.json"
        );
        string memory json = vm.readFile(path);
        CHAINFLIP_VAULT = json.readAddress(".mainnet.chainflipVault");
        vm.label(CHAINFLIP_VAULT, "Chainflip Vault");
        console.log("Chainflip Vault Address:", CHAINFLIP_VAULT);

        chainflipFacet = new TestChainflipFacet(CHAINFLIP_VAULT);
        bytes4[] memory functionSelectors = new bytes4[](4);
        functionSelectors[0] = chainflipFacet
            .startBridgeTokensViaChainflip
            .selector;
        functionSelectors[1] = chainflipFacet
            .swapAndStartBridgeTokensViaChainflip
            .selector;
        functionSelectors[2] = chainflipFacet.addDex.selector;
        functionSelectors[3] = chainflipFacet
            .setFunctionApprovalBySignature
            .selector;

        addFacet(diamond, address(chainflipFacet), functionSelectors);
        chainflipFacet = TestChainflipFacet(address(diamond));
        chainflipFacet.addDex(ADDRESS_UNISWAP);
        chainflipFacet.setFunctionApprovalBySignature(
            uniswap.swapExactTokensForTokens.selector
        );
        chainflipFacet.setFunctionApprovalBySignature(
            uniswap.swapTokensForExactETH.selector
        );
        chainflipFacet.setFunctionApprovalBySignature(
            uniswap.swapETHForExactTokens.selector
        );

        setFacetAddressInTestBase(address(chainflipFacet), "ChainflipFacet");

        // adjust bridgeData
        bridgeData.bridge = "chainflip";
        bridgeData.destinationChainId = 42161; // Arbitrum chain ID

        // produce valid ChainflipData
        validChainflipData = ChainflipFacet.ChainflipData({
            dstToken: 7,
            nonEvmAddress: bytes32(0), // Default to empty for EVM addresses
            cfParameters: ""
        });
    }

    function initiateBridgeTxWithFacet(bool isNative) internal override {
        if (isNative) {
            chainflipFacet.startBridgeTokensViaChainflip{
                value: bridgeData.minAmount
            }(bridgeData, validChainflipData);
        } else {
            chainflipFacet.startBridgeTokensViaChainflip(
                bridgeData,
                validChainflipData
            );
        }
    }

    function initiateSwapAndBridgeTxWithFacet(
        bool isNative
    ) internal override {
        if (isNative) {
            chainflipFacet.swapAndStartBridgeTokensViaChainflip{
                value: swapData[0].fromAmount
            }(bridgeData, swapData, validChainflipData);
        } else {
            chainflipFacet.swapAndStartBridgeTokensViaChainflip(
                bridgeData,
                swapData,
                validChainflipData
            );
        }
    }

    function test_CanBridgeTokensToSolana()
        public
        assertBalanceChange(
            ADDRESS_USDC,
            USER_SENDER,
            -int256(defaultUSDCAmount)
        )
        assertBalanceChange(ADDRESS_USDC, USER_RECEIVER, 0)
        assertBalanceChange(ADDRESS_DAI, USER_SENDER, 0)
        assertBalanceChange(ADDRESS_DAI, USER_RECEIVER, 0)
    {
        bridgeData.receiver = LibAsset.NON_EVM_ADDRESS;
        bridgeData.destinationChainId = CHAIN_ID_SOLANA;
        validChainflipData = ChainflipFacet.ChainflipData({
            dstToken: 6,
            nonEvmAddress: bytes32(
                abi.encodePacked(
                    "EoW7FWTdPdZKpd3WAhH98c2HMGHsdh5yhzzEtk1u68Bb"
                )
            ), // Example Solana address
            cfParameters: ""
        });

        vm.startPrank(USER_SENDER);

        // approval
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        //prepare check for events
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function test_CanBridgeTokensToBitcoin()
        public
        assertBalanceChange(
            ADDRESS_USDC,
            USER_SENDER,
            -int256(defaultUSDCAmount)
        )
        assertBalanceChange(ADDRESS_USDC, USER_RECEIVER, 0)
        assertBalanceChange(ADDRESS_DAI, USER_SENDER, 0)
        assertBalanceChange(ADDRESS_DAI, USER_RECEIVER, 0)
    {
        bridgeData.receiver = LibAsset.NON_EVM_ADDRESS;
        bridgeData.destinationChainId = CHAIN_ID_BITCOIN;
        validChainflipData = ChainflipFacet.ChainflipData({
            dstToken: 6,
            nonEvmAddress: bytes32(
                abi.encodePacked("bc1q6l08rtj6j907r2een0jqs6l7qnruwyxfshmf8a")
            ), // Example Bitcoin address
            cfParameters: ""
        });

        vm.startPrank(USER_SENDER);

        // approval
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        //prepare check for events
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function test_CanBridgeTokensToEthereum()
        public
        assertBalanceChange(
            ADDRESS_USDC,
            USER_SENDER,
            -int256(defaultUSDCAmount)
        )
        assertBalanceChange(ADDRESS_USDC, USER_RECEIVER, 0)
        assertBalanceChange(ADDRESS_DAI, USER_SENDER, 0)
        assertBalanceChange(ADDRESS_DAI, USER_RECEIVER, 0)
    {
        // Set source chain to Arbitrum for this test
        vm.chainId(CHAIN_ID_ARBITRUM);
        vm.roll(208460950); // Set specific block number for Arbitrum chain

        // Set destination to Ethereum
        bridgeData.destinationChainId = CHAIN_ID_ETHEREUM;
        validChainflipData = ChainflipFacet.ChainflipData({
            dstToken: 3, // USDC on Ethereum
            nonEvmAddress: bytes32(0), // Not needed for EVM chains
            cfParameters: ""
        });

        vm.startPrank(USER_SENDER);

        // approval
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        //prepare check for events
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function testRevert_WhenUsingUnsupportedDestinationChain() public {
        // Set destination chain to Polygon (unsupported)
        bridgeData.destinationChainId = 137;

        vm.startPrank(USER_SENDER);

        // approval
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectRevert("ChainflipFacet: Unsupported destination chain");
        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function testRevert_WhenUsingEmptyNonEVMAddress() public {
        bridgeData.receiver = LibAsset.NON_EVM_ADDRESS;
        bridgeData.destinationChainId = CHAIN_ID_SOLANA;
        validChainflipData = ChainflipFacet.ChainflipData({
            dstToken: 6,
            nonEvmAddress: bytes32(0), // Empty address should fail
            cfParameters: ""
        });

        vm.startPrank(USER_SENDER);

        // approval
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectRevert(ChainflipFacet.EmptyNonEvmAddress.selector);
        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function test_CanBridgeTokensWithDestinationCall()
        public
        assertBalanceChange(
            ADDRESS_USDC,
            USER_SENDER,
            -int256(defaultUSDCAmount)
        )
        assertBalanceChange(ADDRESS_USDC, USER_RECEIVER, 0)
        assertBalanceChange(ADDRESS_DAI, USER_SENDER, 0)
        assertBalanceChange(ADDRESS_DAI, USER_RECEIVER, 0)
    {
        // Set destination to Arbitrum where our receiver contract is
        bridgeData.destinationChainId = CHAIN_ID_ARBITRUM;
        bridgeData.hasDestinationCall = true;

        // Create swap data for the destination chain
        LibSwap.SwapData[] memory destSwapData = new LibSwap.SwapData[](0);

        // Encode the message for the receiver contract
        bytes memory message = abi.encode(
            bridgeData.transactionId,
            destSwapData,
            USER_RECEIVER // Final receiver of the tokens
        );

        validChainflipData = ChainflipFacet.ChainflipData({
            dstToken: 7, // USDC on Arbitrum
            nonEvmAddress: bytes32(0), // Not needed for EVM chains
            cfParameters: message // Pass the encoded message for CCM
        });

        vm.startPrank(USER_SENDER);

        // approval
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        //prepare check for events
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }
}
