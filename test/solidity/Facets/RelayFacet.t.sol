// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { LibAllowList, TestBaseFacet, console, ERC20 } from "../utils/TestBaseFacet.sol";
import { RelayFacet } from "lifi/Facets/RelayFacet.sol";
import { ILiFi } from "lifi/Interfaces/ILiFi.sol";

// TODO: Upgrade forge-std lib
// This is a hack to be able to use newer capabilities of forge without having
// to update the forge-std lib as this will break some tests at the moment
interface VmWithUnixTime {
    /// Returns the time since unix epoch in milliseconds.
    function unixTime() external returns (uint256 milliseconds);
}

// Stub RelayFacet Contract
contract TestRelayFacet is RelayFacet {
    constructor(
        address _relayReceiver,
        address _relaySolver
    ) RelayFacet(_relayReceiver, _relaySolver) {}

    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract RelayFacetTest is TestBaseFacet {
    RelayFacet.RelayData internal validRelayData;
    TestRelayFacet internal relayFacet;
    address internal RELAY_RECEIVER =
        0xa5F565650890fBA1824Ee0F21EbBbF660a179934;
    uint256 internal PRIVATE_KEY = 0x1234567890;
    address RELAY_SOLVER = vm.addr(PRIVATE_KEY);
    address internal constant NON_EVM_ADDRESS =
        0x11f111f111f111F111f111f111F111f111f111F1;

    error InvalidQuote();

    function setUp() public {
        customBlockNumberForForking = 19767662;
        initTestBase();
        relayFacet = new TestRelayFacet(RELAY_RECEIVER, RELAY_SOLVER);
        bytes4[] memory functionSelectors = new bytes4[](4);
        functionSelectors[0] = relayFacet.startBridgeTokensViaRelay.selector;
        functionSelectors[1] = relayFacet
            .swapAndStartBridgeTokensViaRelay
            .selector;
        functionSelectors[2] = relayFacet.addDex.selector;
        functionSelectors[3] = relayFacet
            .setFunctionApprovalBySignature
            .selector;

        addFacet(diamond, address(relayFacet), functionSelectors);
        relayFacet = TestRelayFacet(address(diamond));
        relayFacet.addDex(ADDRESS_UNISWAP);
        relayFacet.setFunctionApprovalBySignature(
            uniswap.swapExactTokensForTokens.selector
        );
        relayFacet.setFunctionApprovalBySignature(
            uniswap.swapTokensForExactETH.selector
        );
        relayFacet.setFunctionApprovalBySignature(
            uniswap.swapETHForExactTokens.selector
        );

        setFacetAddressInTestBase(address(relayFacet), "RelayFacet");

        // adjust bridgeData
        bridgeData.bridge = "relay";
        bridgeData.destinationChainId = 137;

        // This will randomly setup bridging to EVM or non-EVM
        if (VmWithUnixTime(address(vm)).unixTime() % 2 == 0) {
            validRelayData = RelayFacet.RelayData({
                requestId: bytes32("1234"),
                nonEVMReceiver: "",
                receivingAssetId: bytes32(
                    uint256(
                        uint160(0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174)
                    )
                ), // Polygon USDC
                callData: "",
                signature: ""
            });
        } else {
            bridgeData.receiver = NON_EVM_ADDRESS;
            bridgeData.destinationChainId = 792703809;
            validRelayData = RelayFacet.RelayData({
                requestId: bytes32("1234"),
                nonEVMReceiver: bytes32(
                    abi.encodePacked(
                        "EoW7FWTdPdZKpd3WAhH98c2HMGHsdh5yhzzEtk1u68Bb"
                    )
                ), // DEV Wallet
                receivingAssetId: bytes32(
                    abi.encodePacked(
                        "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
                    )
                ), // Solana USDC
                callData: "",
                signature: ""
            });
        }
    }

    function initiateBridgeTxWithFacet(bool isNative) internal override {
        validRelayData.signature = signData(bridgeData, validRelayData);
        if (isNative) {
            relayFacet.startBridgeTokensViaRelay{
                value: bridgeData.minAmount
            }(bridgeData, validRelayData);
        } else {
            validRelayData.callData = abi.encodeWithSignature(
                "transfer(address,uint256)",
                RELAY_SOLVER,
                bridgeData.minAmount
            );
            relayFacet.startBridgeTokensViaRelay(bridgeData, validRelayData);
        }
    }

    function initiateSwapAndBridgeTxWithFacet(
        bool isNative
    ) internal override {
        validRelayData.signature = signData(bridgeData, validRelayData);
        if (isNative) {
            relayFacet.swapAndStartBridgeTokensViaRelay{
                value: swapData[0].fromAmount
            }(bridgeData, swapData, validRelayData);
        } else {
            validRelayData.callData = abi.encodeWithSignature(
                "transfer(address,uint256)",
                RELAY_SOLVER,
                bridgeData.minAmount
            );
            relayFacet.swapAndStartBridgeTokensViaRelay(
                bridgeData,
                swapData,
                validRelayData
            );
        }
    }

    function testRevert_BridgeWithInvalidSignature() public virtual {
        vm.startPrank(USER_SENDER);

        // approval
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        PRIVATE_KEY = 0x0987654321;

        vm.expectRevert(InvalidQuote.selector);
        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function signData(
        ILiFi.BridgeData memory _bridgeData,
        RelayFacet.RelayData memory _relayData
    ) internal view returns (bytes memory) {
        bytes32 message = keccak256(
            abi.encodePacked(
                "\x19Ethereum Signed Message:\n32",
                keccak256(
                    abi.encodePacked(
                        _relayData.requestId,
                        block.chainid,
                        bytes32(uint256(uint160(address(relayFacet)))),
                        bytes32(uint256(uint160(_bridgeData.sendingAssetId))),
                        _getMappedChainId(_bridgeData.destinationChainId),
                        _bridgeData.receiver == NON_EVM_ADDRESS
                            ? _relayData.nonEVMReceiver
                            : bytes32(uint256(uint160(_bridgeData.receiver))),
                        _relayData.receivingAssetId
                    )
                )
            )
        );

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(PRIVATE_KEY, message);
        bytes memory signature = abi.encodePacked(r, s, v);
        return signature;
    }

    function _getMappedChainId(
        uint256 chainId
    ) internal pure returns (uint256) {
        if (chainId == 20000000000001) {
            return 8253038;
        }

        if (chainId == 1151111081099710) {
            return 792703809;
        }

        return chainId;
    }
}
