// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { Test } from "forge-std/Test.sol";
import { StandardizedCallFacet } from "lifi/Facets/StandardizedCallFacet.sol";
import { LiFiDiamond } from "lifi/LiFiDiamond.sol";
import { DiamondTest } from "../utils/DiamondTest.sol";

interface Diamond {
    function standardizedCall(bytes calldata _data) external payable;

    function registerPeripheryContract(
        string calldata _name,
        address _contract
    ) external;

    function getPeripheryContract(
        string calldata _name
    ) external view returns (address);
}

contract NotAContract {
    function notAFunction() external {}
}

contract StandardizedCallFacetTest is DiamondTest, Test {
    Diamond internal diamond;
    StandardizedCallFacet internal standardizedCallFacet;

    function setUp() public {
        LiFiDiamond tmpDiamond = createDiamond();
        standardizedCallFacet = new StandardizedCallFacet();

        bytes4[] memory functionSelectors = new bytes4[](1);
        functionSelectors[0] = standardizedCallFacet.standardizedCall.selector;
        addFacet(
            tmpDiamond,
            address(standardizedCallFacet),
            functionSelectors
        );

        diamond = Diamond(address(tmpDiamond));
    }

    function testCanCallOtherFacet() public {
        bytes memory data = abi.encodeWithSelector(
            diamond.registerPeripheryContract.selector,
            "Foobar",
            address(0xf00)
        );

        diamond.standardizedCall(data);
        address result = diamond.getPeripheryContract("Foobar");
        assertEq(result, address(0xf00));
    }

    function testFailWhenCallingANonExistentFunction() public {
        bytes memory data = abi.encodeWithSelector(
            NotAContract.notAFunction.selector
        );

        diamond.standardizedCall(data);
    }
}
