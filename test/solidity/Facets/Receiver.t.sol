// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { DSTest } from "ds-test/test.sol";
import { console } from "../utils/Console.sol";
import { DiamondTest, LiFiDiamond } from "../utils/DiamondTest.sol";
import { Vm } from "forge-std/Vm.sol";
import { AcrossFacet } from "lifi/Facets/AcrossFacet.sol";
import { ILiFi } from "lifi/Interfaces/ILiFi.sol";
import { IAcrossSpokePool } from "lifi/Interfaces/IAcrossSpokePool.sol";
import { LibSwap } from "lifi/Libraries/LibSwap.sol";
import { LibAllowList } from "lifi/Libraries/LibAllowList.sol";
import { ERC20 } from "solmate/tokens/ERC20.sol";
import { UniswapV2Router02 } from "../utils/Interfaces.sol";
import { Receiver } from "lifi/Periphery/Receiver.sol";
import { LibSwap } from "lifi/Libraries/LibSwap.sol";

// Stub CBridgeFacet Contract
contract TestReceiverContract is Receiver {
    constructor(address owner)
        Receiver(owner, 0x4a364f8c717cAAD9A442737Eb7b8A55cc6cf18D8, 0xaF15c6a1a23300b2cEdc24bdfFB8f810bb4DfC63, 100000)
    {}
}

contract ReceiverTest is DSTest, DiamondTest {
    Vm internal immutable vm = Vm(HEVM_ADDRESS);
    LiFiDiamond internal diamond;
    TestReceiverContract internal receiver;

    function fork() internal {
        string memory rpcUrl = "https://bsc-dataseed.binance.org/";
        uint256 blockNumber = 22051051;
        vm.createSelectFork(rpcUrl, blockNumber);
    }

    function setUp() public {
        fork();

        diamond = createDiamond();
        receiver = new TestReceiverContract(0x4a364f8c717cAAD9A442737Eb7b8A55cc6cf18D8);
        bytes4[] memory functionSelectors = new bytes4[](1);
        functionSelectors[0] = receiver.sgReceive.selector;

        addFacet(diamond, address(receiver), functionSelectors);

        receiver = TestReceiverContract(address(diamond));
    }
}
