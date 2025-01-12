// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.17;
//
import { TestBase } from "./TestBase.sol";

// import { MyFacet } from "lifi/Facets/MyFacet.sol"; // Update with your facet import
//
contract MyNewTest is TestBase {
    //     MyFacet internal myFacet;
    //
    //     function setUp() public {
    //         // Optional: Set custom fork parameters
    //         // customBlockNumberForForking = 12345678;
    //         // customRpcUrlForForking = "ETH_NODE_URI_MAINNET";
    //
    //         initTestBase();
    //
    //         // Deploy facet
    //         myFacet = new MyFacet();
    //
    //         // Add facet to diamond
    //         bytes4[] memory selectors = new bytes4[](1);
    //         selectors[0] = myFacet.someFunction.selector;
    //         addFacet(diamond, address(myFacet), selectors);
    //
    //         // Cast diamond address to facet
    //         myFacet = MyFacet(address(diamond));
    //     }
    //
    //     function testSomething() public {
    //         // Your test code
    //         myFacet.someFunction();
    //     }
}
