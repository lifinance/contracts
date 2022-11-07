// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { DSTest } from "ds-test/test.sol";
import { console } from "../utils/Console.sol";
import { DiamondTest, LiFiDiamond } from "../utils/DiamondTest.sol";
import { Vm } from "forge-std/Vm.sol";
import { ERC20 } from "solmate/tokens/ERC20.sol";
import { WithdrawFacet } from "lifi/Facets/WithdrawFacet.sol";

// Test CBridge refund by forking polygon at 25085298
// Actual refund was processed at 25085299(Feb-18-2022 03:24:09 PM +UTC)
// Run `forge test --match-path test\solidity\Facets\CBridgeRefund.t.sol --fork-url POLYGON_RPC_URL --fork-block-number 25085298`
// or `forge test --match-contract CBridgeRefundTest --fork-url POLYGON_RPC_URL --fork-block-number 25085298`
contract CBridgeRefundTestPolygon is DSTest, DiamondTest {
    address internal constant CBRIDGE_ADDRESS = 0x88DCDC47D2f83a99CF0000FDF667A468bB958a78;
    address internal constant LIFI_ADDRESS = 0x5A9Fd7c39a6C488E715437D7b1f3C823d5596eD1;
    address internal constant OWNER_ADDRESS = 0xCB1e9fA11Edd27098A6B2Ff23cB6b79183ccf8Ee;

    // Reference to https://polygonscan.com/tx/0x989872993fde04e81e74027047032305201448da4a4b32999d83fdd2b18ad3bd
    address internal constant REFUND_ASSET = 0x60bB3D364B765C497C8cE50AE0Ae3f0882c5bD05; // IMX Token
    address internal constant REFUND_ADDRESS = 0x3db00D1334B5faDd2A897D8A702cDCbb6F159D87;
    uint256 internal constant REFUND_AMOUNT = 92734538876076486098;

    bytes internal CALLDATA;

    Vm internal constant vm = Vm(HEVM_ADDRESS);
    LiFiDiamond internal diamond;
    WithdrawFacet internal withdrawFacet;

    ///@notice Init calldata for extra call.
    ///@dev Reference to https://polygonscan.com/tx/0x4693cf438f3e54d8cb0dbc27fed20ec664b36ce34761dd008d2d958dec8477aa
    function initCallData() public {
        bytes
            memory MSG = hex"08890110fbf3be90061a145a9fd7c39a6c488e715437d7b1f3c823d5596ed1221460bb3d364b765c497c8ce50ae0ae3f0882c5bd052a090506f343c77630edd2322042b99ab301f0bf5e0bd9b58d16266899ae2402a1e7cb0913903c7f876b4bce5f";

        bytes[] memory SIGS = new bytes[](4);
        SIGS[
            0
        ] = hex"12f92050a88caaa23ad57ee86ff12534205c157e5ce7ca5cd0b4db91c4d041103ce5063cb692651482738a0663be37b4ed776ab5879ca717a349cdb24d68d11c1c";
        SIGS[
            1
        ] = hex"e0ac807bf17703129299922d99ace508e5a1313b7932cbe8e44c1ad0c9a914fc0696a324543af4ad0a3efec2d5fdb276d38b2e633a4ba30aba1fdff8b7013ff01c";
        SIGS[
            2
        ] = hex"dffdb895ffbef44c36d68c6e0bb7ce9b2f30e93860ede78a7cef2109afa87f96764b475a60da121dfdd7b68e692d1c6dbfa0719b01caa5faa2fbdd0c8d4591e61c";
        SIGS[
            3
        ] = hex"8ecfc94c4687adc679807982e501651261e74c981bd4287118220eb57a0175a87e248db2e5c0f1aae531381e2c2080306df24bf0cbf45e55d6c939555b7e6afd1c";

        address[] memory SIGNERS = new address[](4);
        SIGNERS[0] = 0x98E9D288743839e96A8005a6B51C770Bbf7788C0;
        SIGNERS[1] = 0x9a66644084108a1bC23A9cCd50d6d63E53098dB6;
        SIGNERS[2] = 0xbfa2F68bf9Ad60Dc3cFB1cEF04730Eb7FA251424;
        SIGNERS[3] = 0xd10c833f4305E1053a64Bc738c550381f48104Ca;

        uint256[] memory POWERS = new uint256[](4);
        POWERS[0] = 150010000000000000000000000;
        POWERS[1] = 150010000000000000000000000;
        POWERS[2] = 150010000000000000000000000;
        POWERS[3] = 150010000000000000000000000;

        CALLDATA = abi.encodeWithSignature("withdraw(bytes,bytes[],address[],uint256[])", MSG, SIGS, SIGNERS, POWERS);
    }

    function fork() internal {
        string memory rpcUrl = vm.envString("ETH_NODE_URI_POLYGON");
        uint256 blockNumber = vm.envUint("POLYGON_FORK_NUMBER");
        vm.createSelectFork(rpcUrl, blockNumber);
    }

    /// @notice Setup contracts for test.
    /// @dev It adds selector of new function(executeCallAndWithdraw).
    /// And initialize calldata for extra call.
    function setUp() public {
        fork();

        diamond = LiFiDiamond(payable(LIFI_ADDRESS));
        withdrawFacet = new WithdrawFacet();

        bytes4[] memory selector = new bytes4[](1);
        selector[0] = withdrawFacet.executeCallAndWithdraw.selector;

        vm.startPrank(OWNER_ADDRESS);
        addFacet(diamond, address(withdrawFacet), selector);
        vm.stopPrank();

        withdrawFacet = WithdrawFacet(address(diamond));

        initCallData();
    }

    /// @notice Execute extra call and withdraw refunded assets to receiver.
    /// @dev It executes extra call at CBRIDGE_ADDRESS to transfer asset from
    ///     CBridge to WithdrawFacet.
    ///     Then it withdraws the asset to REFUND_ADDRESS
    function testCanExecuteCallAndWithdraw() public {
        ERC20 asset = ERC20(REFUND_ASSET);
        uint256 assetBalance = asset.balanceOf(REFUND_ADDRESS);

        vm.startPrank(OWNER_ADDRESS);
        vm.chainId(137); // Only needed because of bug in forge forking...

        withdrawFacet.executeCallAndWithdraw(
            payable(CBRIDGE_ADDRESS),
            CALLDATA,
            REFUND_ASSET,
            REFUND_ADDRESS,
            REFUND_AMOUNT
        );
        vm.stopPrank();

        assert(asset.balanceOf(REFUND_ADDRESS) == assetBalance + REFUND_AMOUNT);
    }

    /// @notice Fails to execute extra call and withdraw from non-owner.
    /// @dev It calls executeCallAndWithdraw from address that is not OWNER_ADDRESS.
    function testFailExecuteCallAndWithdrawFromNonOwner() public {
        withdrawFacet.executeCallAndWithdraw(
            payable(CBRIDGE_ADDRESS),
            CALLDATA,
            REFUND_ASSET,
            REFUND_ADDRESS,
            REFUND_AMOUNT
        );
    }

    /// @notice Fails to execute extra call and withdraw when callTo is invalid.
    /// @dev It tries to execute extra call at REFUND_ADDRESS instead of CBRIDGE_ADDRESS.
    function testFailExecuteCallAndWithdraw() public {
        withdrawFacet.executeCallAndWithdraw(
            payable(REFUND_ADDRESS),
            CALLDATA,
            REFUND_ASSET,
            REFUND_ADDRESS,
            REFUND_AMOUNT
        );
    }

    /// @notice Fails to execute extra call and withdraw when refund is already processed.
    /// @dev It tries to withdraw multiple times.
    ///     First withdraw should be success but second withdraw should be failed.
    function testFailExecuteCallAndWithdrawMultiple() public {
        ERC20 asset = ERC20(REFUND_ASSET);
        uint256 assetBalance = asset.balanceOf(REFUND_ADDRESS);

        vm.startPrank(OWNER_ADDRESS);
        vm.chainId(137); // Only needed because of bug in forge forking...
        withdrawFacet.executeCallAndWithdraw(
            payable(CBRIDGE_ADDRESS),
            CALLDATA,
            REFUND_ASSET,
            REFUND_ADDRESS,
            REFUND_AMOUNT
        );
        assert(asset.balanceOf(REFUND_ADDRESS) == assetBalance + REFUND_AMOUNT);

        withdrawFacet.executeCallAndWithdraw(
            payable(CBRIDGE_ADDRESS),
            CALLDATA,
            REFUND_ASSET,
            REFUND_ADDRESS,
            REFUND_AMOUNT
        );
        vm.stopPrank();
    }
}
