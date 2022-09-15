// SPDX-License-Identifier: Unlicensed
pragma solidity 0.8.16;

import { DSTest } from "ds-test/test.sol";
import { console } from "../utils/Console.sol";
import { Vm } from "forge-std/Vm.sol";
import { AxelarExecutor } from "lifi/Periphery/AxelarExecutor.sol";
import { ERC20Proxy } from "lifi/Periphery/ERC20Proxy.sol";
import { TestToken as ERC20 } from "../utils/TestToken.sol";

// Stub Vault Contract
contract Vault {
    function deposit(address token, uint256 amount) external {
        ERC20(token).transferFrom(msg.sender, address(this), amount);
    }
}

contract Setter {
    string public message;

    function setMessage(string calldata _message) external {
        message = _message;
    }
}

contract MockGateway {
    mapping(string => address) public tokenAddresses;

    function validateContractCall(
        bytes32,
        string calldata,
        string calldata,
        bytes32
    ) external pure returns (bool) {
        return true;
    }

    function validateContractCallAndMint(
        bytes32,
        string calldata,
        string calldata,
        bytes32,
        string memory,
        uint256
    ) external pure returns (bool) {
        return true;
    }

    function setTokenAddress(string memory _symbol, address _tokenAddress) external {
        tokenAddresses[_symbol] = _tokenAddress;
    }
}

contract ExecutorTest is DSTest {
    Vm internal immutable vm = Vm(HEVM_ADDRESS);
    AxelarExecutor internal executor;
    Vault internal vault;
    Setter internal setter;
    MockGateway internal gw;

    function setUp() public {
        gw = new MockGateway();
        executor = new AxelarExecutor(address(this), address(gw));
        vault = new Vault();
        setter = new Setter();
    }

    function testCanExecuteAxelarPayload() public {
        executor.execute(
            bytes32("abcde"),
            "polygon",
            "0x1234",
            abi.encodePacked(address(setter), abi.encodeWithSignature("setMessage(string)", "lifi"))
        );

        assertEq(setter.message(), "lifi");
    }

    function testCanExecuteAxelarPayloadWithToken() public {
        ERC20 aUSDC = new ERC20("Axelar USDC", "aUSDC", 18);
        address recoveryAddress = address(this);
        aUSDC.mint(address(this), 100 ether);
        gw.setTokenAddress("aUSDC", address(aUSDC));
        aUSDC.transfer(address(executor), 0.01 ether);
        executor.executeWithToken(
            bytes32("abcde"),
            "polygon",
            "0x1234",
            abi.encodePacked(
                address(vault),
                recoveryAddress,
                abi.encodeWithSignature("deposit(address,uint256)", address(aUSDC), 0.01 ether)
            ),
            "aUSDC",
            0.01 ether
        );
    }
}
