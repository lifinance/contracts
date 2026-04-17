// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { Test } from "forge-std/Test.sol";
import { LiFiDiamond } from "lifi/LiFiDiamond.sol";
import { DiamondTest } from "../../../utils/DiamondTest.sol";
import { TestWhitelistManagerBase } from "../../../utils/TestWhitelistManagerBase.sol";
import { MockUniswapDEX } from "../../../utils/MockUniswapDEX.sol";
import { TestToken } from "../../../utils/TestToken.sol";

import { AcrossV4SwapFacet } from "lifi/Facets/AcrossV4SwapFacet.sol";
import { ISpokePoolPeriphery } from "lifi/Interfaces/ISpokePoolPeriphery.sol";
import { ISponsoredOFTSrcPeriphery } from "lifi/Interfaces/ISponsoredOFTSrcPeriphery.sol";
import { ISponsoredCCTPSrcPeriphery } from "lifi/Interfaces/ISponsoredCCTPSrcPeriphery.sol";
import { LibSwap } from "lifi/Libraries/LibSwap.sol";

contract MockSponsoredOftSrcPeriphery is ISponsoredOFTSrcPeriphery {
    address internal immutable TOKEN_ADDRESS;

    constructor(address _token) {
        TOKEN_ADDRESS = _token;
    }

    function TOKEN() external view override returns (address) {
        return TOKEN_ADDRESS;
    }

    function deposit(
        Quote calldata,
        bytes calldata
    ) external payable override {}
}

contract MockSponsoredCctpSrcPeriphery is ISponsoredCCTPSrcPeriphery {
    function depositForBurn(
        SponsoredCCTPQuote calldata,
        bytes calldata
    ) external override {}
}

contract TestAcrossV4SwapFacetSponsored is
    AcrossV4SwapFacet,
    TestWhitelistManagerBase
{
    constructor(
        ISpokePoolPeriphery _spokePoolPeriphery,
        address _spokePool,
        address _wrappedNative,
        address _sponsoredOftSrcPeriphery,
        address _sponsoredCctpSrcPeriphery,
        address _backendSigner
    )
        AcrossV4SwapFacet(
            _spokePoolPeriphery,
            _spokePool,
            _wrappedNative,
            _sponsoredOftSrcPeriphery,
            _sponsoredCctpSrcPeriphery,
            _backendSigner
        )
    {}
}

abstract contract AcrossV4SwapFacetSponsoredTestBase is Test, DiamondTest {
    address internal constant USER_SENDER = address(0xabc123456);
    address internal constant USER_RECEIVER = address(0xabc654321);
    address internal constant USER_PAUSER = address(0xdeadbeef);
    address internal constant USER_DIAMOND_OWNER =
        0x5042255A3F3FD7727e419CeA387cAFDfad3C3aF8;

    address internal constant SPOKE_POOL = address(0xBEEF); // required non-zero (not used)
    address internal constant WRAPPED_NATIVE = address(0xB0B); // required non-zero (not used)

    uint256 internal backendSignerPk;
    address internal backendSigner;

    LiFiDiamond internal diamond;
    AcrossV4SwapFacet internal facet;

    MockUniswapDEX internal dex;
    TestToken internal dai;
    TestToken internal tokenOut;
    MockSponsoredOftSrcPeriphery internal oftPeriphery;
    MockSponsoredCctpSrcPeriphery internal cctpPeriphery;

    function setUp() public virtual {
        vm.deal(USER_SENDER, 10 ether);

        backendSignerPk = 0xA11CE;
        backendSigner = vm.addr(backendSignerPk);

        dex = new MockUniswapDEX();
        dai = new TestToken("DAI", "DAI", 18);
        tokenOut = new TestToken("TOK", "TOK", 6);
        oftPeriphery = new MockSponsoredOftSrcPeriphery(address(tokenOut));
        cctpPeriphery = new MockSponsoredCctpSrcPeriphery();

        diamond = createDiamond(USER_DIAMOND_OWNER, USER_PAUSER);

        TestAcrossV4SwapFacetSponsored facetImpl = new TestAcrossV4SwapFacetSponsored(
                ISpokePoolPeriphery(address(0)),
                SPOKE_POOL,
                WRAPPED_NATIVE,
                address(oftPeriphery),
                address(cctpPeriphery),
                backendSigner
            );

        bytes4[] memory selectors = new bytes4[](3);
        selectors[0] = facetImpl.startBridgeTokensViaAcrossV4Swap.selector;
        selectors[1] = facetImpl
            .swapAndStartBridgeTokensViaAcrossV4Swap
            .selector;
        selectors[2] = facetImpl.addAllowedContractSelector.selector;
        addFacet(diamond, address(facetImpl), selectors);

        facet = AcrossV4SwapFacet(address(diamond));

        TestAcrossV4SwapFacetSponsored(address(diamond))
            .addAllowedContractSelector(
                address(dex),
                MockUniswapDEX.swapExactTokensForTokens.selector
            );
    }

    function _swapDataDaiToTokenOut(
        uint256 quotedAmount,
        uint256 swapOutputAmount
    ) internal returns (LibSwap.SwapData[] memory swapData) {
        swapData = new LibSwap.SwapData[](1);

        address[] memory path = new address[](2);
        path[0] = address(dai);
        path[1] = address(tokenOut);

        swapData[0] = LibSwap.SwapData({
            callTo: address(dex),
            approveTo: address(dex),
            sendingAssetId: address(dai),
            receivingAssetId: address(tokenOut),
            fromAmount: 100e18,
            callData: abi.encodeWithSelector(
                MockUniswapDEX.swapExactTokensForTokens.selector,
                100e18,
                quotedAmount,
                path,
                address(diamond),
                block.timestamp + 20 minutes
            ),
            requiresDeposit: true
        });

        dai.mint(USER_SENDER, swapData[0].fromAmount);
        tokenOut.mint(address(dex), swapOutputAmount);

        dex.setSwapOutput(swapData[0].fromAmount, tokenOut, swapOutputAmount);
    }
}
