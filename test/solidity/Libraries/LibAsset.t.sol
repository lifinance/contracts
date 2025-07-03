// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { TestBase } from "../utils/TestBase.sol";
import { LibAsset } from "lifi/Libraries/LibAsset.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { InvalidReceiver, NullAddrIsNotAValidSpender, InvalidAmount, NullAddrIsNotAnERC20Token } from "lifi/Errors/GenericErrors.sol";

contract LibAssetImplementer {
    function transferAsset(
        address assetId,
        address payable recipient,
        uint256 amount
    ) public {
        LibAsset.transferAsset(assetId, recipient, amount);
    }

    function transferFromERC20(
        address assetId,
        address from,
        address payable recipient,
        uint256 amount
    ) public {
        LibAsset.transferFromERC20(assetId, from, recipient, amount);
    }

    function approveERC20(
        address assetId,
        address spender,
        uint256 requiredAllowance,
        uint256 setAllowanceTo
    ) public {
        LibAsset.approveERC20(
            IERC20(assetId),
            spender,
            requiredAllowance,
            setAllowanceTo
        );
    }

    function depositAsset(address assetId, uint256 amount) public {
        LibAsset.depositAsset(assetId, amount);
    }

    function isContract(address _contractAddr) public view returns (bool) {
        return LibAsset.isContract(_contractAddr);
    }
}

contract LibAssetTest is TestBase {
    LibAssetImplementer internal implementer;

    function setUp() public {
        implementer = new LibAssetImplementer();
        initTestBase();
    }

    function testRevert_approveToZeroAddress() public {
        vm.expectRevert(NullAddrIsNotAValidSpender.selector);

        implementer.approveERC20(
            ADDRESS_USDC,
            address(0),
            defaultUSDCAmount,
            type(uint256).max
        );
    }

    function test_approveERC20WithNativeAsset() public {
        // Should return early without reverting when trying to approve native asset
        implementer.approveERC20(address(0), address(1), 1, 1);
    }

    function testRevert_transferERC20ToZeroAddress() public {
        vm.expectRevert(InvalidReceiver.selector);

        implementer.transferAsset(
            ADDRESS_USDC,
            payable(address(0)),
            defaultUSDCAmount
        );
    }

    function testRevert_transferNativeToZeroAddress() public {
        vm.expectRevert(InvalidReceiver.selector);

        implementer.transferAsset(
            address(0),
            payable(address(0)),
            defaultUSDCAmount
        );
    }

    function testRevert_transferFromERC20ToZeroAddress() public {
        vm.expectRevert(InvalidReceiver.selector);

        implementer.transferFromERC20(
            ADDRESS_USDC,
            USER_SENDER,
            payable(address(0)),
            defaultUSDCAmount
        );
    }

    function testRevert_transferFromERC20WithNativeAsset() public {
        vm.expectRevert(NullAddrIsNotAnERC20Token.selector);

        implementer.transferFromERC20(
            address(0),
            makeAddr("Alice"),
            payable(makeAddr("Bob")),
            defaultUSDCAmount
        );
    }

    function testRevert_depositZeroAmount() public {
        vm.expectRevert(InvalidAmount.selector);

        implementer.depositAsset(ADDRESS_USDC, 0);
    }

    function test_isContract() public {
        bool result = implementer.isContract(ADDRESS_USDC);

        assertEq(result, true);
    }

    function test_isNotAContract() public {
        bool result = implementer.isContract(address(0));

        assertEq(result, false);

        result = implementer.isContract(USER_SENDER);

        assertEq(result, false);
    }

    function test_isContractWithDelegationDesignator() public {
        // 0xef0100 is the delegation designator
        // build a 23‑byte blob: 0xef0100 ‖ <20‑byte delegate address>
        // here we just point back at the test contract itself,
        // but you can put any 20‑byte address
        bytes memory aaCode = abi.encodePacked(
            hex"ef0100",
            bytes20(address(this))
        );

        vm.etch(USER_SENDER, aaCode); // inject the delegation designator into the USER_SENDER address

        bool result = implementer.isContract(USER_SENDER);
        assertFalse(result, "Delegated EOA is not a contract");
    }
}
