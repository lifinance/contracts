// SPDX-License-Identifier: LGPL-3.0-only

pragma solidity ^0.8.17;

import { TestBaseFacet } from "../utils/TestBaseFacet.sol";
import { ERC20 } from "solmate/tokens/ERC20.sol";
import { LibAllowList } from "lifi/Libraries/LibAllowList.sol";
import { EcoFacet } from "lifi/Facets/EcoFacet.sol";
import { IEcoPortal } from "lifi/Interfaces/IEcoPortal.sol";
import { InvalidConfig } from "lifi/Errors/GenericErrors.sol";

contract TestEcoFacet is EcoFacet {
    constructor(IEcoPortal _intentSource) EcoFacet(_intentSource) {}

    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract EcoFacetTest is TestBaseFacet {
    TestEcoFacet internal ecoFacet;
    address internal constant PORTAL =
        0x90F0c8aCC1E083Bcb4F487f84FC349ae8d5e28D7;
    uint256 internal constant SOLVER_REWARD = 0.0001 ether;

    function setUp() public {
        customBlockNumberForForking = 34694289;
        customRpcUrlForForking = "ETH_NODE_URI_BASE";
        initTestBase();
        addLiquidity(
            ADDRESS_USDC,
            ADDRESS_DAI,
            1000000 * 10 ** ERC20(ADDRESS_USDC).decimals(),
            1000000 * 10 ** ERC20(ADDRESS_DAI).decimals()
        );
        addLiquidity(
            ADDRESS_WRAPPED_NATIVE,
            ADDRESS_USDC,
            100 ether,
            1000000 * 10 ** ERC20(ADDRESS_USDC).decimals()
        );

        ecoFacet = new TestEcoFacet(IEcoPortal(PORTAL));

        bytes4[] memory functionSelectors = new bytes4[](4);
        functionSelectors[0] = ecoFacet.startBridgeTokensViaEco.selector;
        functionSelectors[1] = ecoFacet
            .swapAndStartBridgeTokensViaEco
            .selector;
        functionSelectors[2] = ecoFacet.addDex.selector;
        functionSelectors[3] = ecoFacet
            .setFunctionApprovalBySignature
            .selector;

        addFacet(diamond, address(ecoFacet), functionSelectors);
        ecoFacet = TestEcoFacet(address(diamond));
        ecoFacet.addDex(ADDRESS_UNISWAP);
        ecoFacet.setFunctionApprovalBySignature(
            uniswap.swapExactTokensForTokens.selector
        );
        ecoFacet.setFunctionApprovalBySignature(
            uniswap.swapTokensForExactETH.selector
        );
        ecoFacet.setFunctionApprovalBySignature(
            uniswap.swapETHForExactTokens.selector
        );

        setFacetAddressInTestBase(address(ecoFacet), "EcoFacet");

        bridgeData.bridge = "eco";
        bridgeData.destinationChainId = 10;

        // Set addToMessageValue to the solver reward (similar to how StargateFacetV2 sets it to the bridge fee)
        addToMessageValue = SOLVER_REWARD;
    }

    function getValidEcoData()
        internal
        view
        returns (EcoFacet.EcoData memory)
    {
        IEcoPortal.Call[] memory emptyCalls = new IEcoPortal.Call[](0);

        return
            EcoFacet.EcoData({
                receiverAddress: USER_RECEIVER,
                nonEVMReceiver: "",
                receivingAssetId: ADDRESS_USDC_OPTIMISM,
                salt: keccak256(abi.encode(block.timestamp)),
                routeDeadline: uint64(block.timestamp + 1 days),
                destinationPortal: PORTAL, // Same on OP,
                prover: address(0x1234),
                rewardDeadline: uint64(block.timestamp + 2 days),
                solverReward: SOLVER_REWARD,
                destinationCalls: emptyCalls
            });
    }

    function initiateBridgeTxWithFacet(bool isNative) internal override {
        EcoFacet.EcoData memory ecoData = getValidEcoData();

        if (isNative) {
            // For native tokens, send bridge amount + addToMessageValue (solver reward)
            ecoFacet.startBridgeTokensViaEco{
                value: bridgeData.minAmount + addToMessageValue
            }(bridgeData, ecoData);
        } else {
            // For ERC20 tokens, only send addToMessageValue (solver reward) as msg.value
            ecoFacet.startBridgeTokensViaEco{ value: addToMessageValue }(
                bridgeData,
                ecoData
            );
        }
    }

    function initiateSwapAndBridgeTxWithFacet(
        bool isNative
    ) internal override {
        EcoFacet.EcoData memory ecoData = getValidEcoData();

        if (isNative) {
            // For swapping to native, send swap input amount + addToMessageValue (solver reward)
            ecoFacet.swapAndStartBridgeTokensViaEco{
                value: swapData[0].fromAmount + addToMessageValue
            }(bridgeData, swapData, ecoData);
        } else {
            // For swapping from native to ERC20, only send addToMessageValue (solver reward)
            ecoFacet.swapAndStartBridgeTokensViaEco{
                value: addToMessageValue
            }(bridgeData, swapData, ecoData);
        }
    }

    function testRevert_WhenUsingInvalidConfig() public {
        vm.expectRevert(InvalidConfig.selector);
        new EcoFacet(IEcoPortal(address(0)));
    }
}
