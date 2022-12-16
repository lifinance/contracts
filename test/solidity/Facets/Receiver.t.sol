// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { Test } from "forge-std/Test.sol";
import { console } from "../utils/Console.sol";
import { Vm } from "forge-std/Vm.sol";
import { LibSwap } from "lifi/Libraries/LibSwap.sol";
import { ERC20 } from "solmate/tokens/ERC20.sol";
import { Receiver } from "lifi/Periphery/Receiver.sol";
import { stdJson } from "forge-std/Script.sol";

contract ReceiverTest is Test {
    using stdJson for string;

    Receiver internal receiver;
    address internal USDC = 0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174;

    string path = string.concat(vm.projectRoot(), "/config/stargate.json");
    string json = vm.readFile(path);
    address stargateRouter = json.readAddress(string.concat(".routers.polygon"));

    event LiFiTransferRecovered(
        bytes32 indexed transactionId,
        address receivingAssetId,
        address receiver,
        uint256 amount,
        uint256 timestamp
    );

    function fork() internal {
        string memory rpcUrl = vm.rpcUrl("polygon");
        uint256 blockNumber = 36290139;
        vm.createSelectFork(rpcUrl, blockNumber);
    }

    function setUp() public {
        fork();
        receiver = new Receiver(address(this), stargateRouter, address(1), 100000);
        deal(USDC, stargateRouter, 10_000e18);
    }

    function testEmitsCorrectEventOnRecovery() public {
        LibSwap.SwapData memory swapData;
        bytes memory payload = abi.encode(keccak256("123"), swapData, address(1), address(1));

        vm.startPrank(stargateRouter);
        ERC20(USDC).transfer(address(receiver), 1000e18);

        vm.expectEmit(true, true, true, true, address(receiver));
        emit LiFiTransferRecovered(keccak256("123"), USDC, address(1), 1000e18, block.timestamp);

        receiver.sgReceive{ gas: 100000 }(0, "", 0, USDC, 1000e18, payload);
    }
}
