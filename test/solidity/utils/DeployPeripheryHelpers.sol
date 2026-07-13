// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { Vm } from "forge-std/Vm.sol";
import { ERC20Proxy } from "lifi/Periphery/ERC20Proxy.sol";
import { Executor } from "lifi/Periphery/Executor.sol";

library DeployPeripheryHelpers {
    error ExecutorAddressMismatch();
    error ExecutorNotAuthorized();

    Vm private constant VM =
        Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// @dev Mirrors production deploy: ERC20Proxy pre-authorizes the predicted Executor address.
    function deployERC20ProxyAndExecutor(
        address deployer,
        address owner
    ) internal returns (ERC20Proxy erc20Proxy, Executor executor) {
        uint256 executorNonce = VM.getNonce(deployer) + 1;
        address predictedExecutor = computeCreateAddress(
            deployer,
            executorNonce
        );

        erc20Proxy = new ERC20Proxy(owner, predictedExecutor);
        executor = new Executor(address(erc20Proxy), owner);

        if (address(executor) != predictedExecutor) {
            revert ExecutorAddressMismatch();
        }
        if (!erc20Proxy.authorizedCallers(address(executor))) {
            revert ExecutorNotAuthorized();
        }
    }

    /// @dev Same RLP logic as forge-std StdUtils.computeCreateAddress
    function computeCreateAddress(
        address deployer,
        uint256 nonce
    ) private pure returns (address) {
        if (nonce == 0x00) {
            return
                addressFromLast20Bytes(
                    keccak256(
                        abi.encodePacked(
                            bytes1(0xd6),
                            bytes1(0x94),
                            deployer,
                            bytes1(0x80)
                        )
                    )
                );
        }
        if (nonce <= 0x7f) {
            return
                addressFromLast20Bytes(
                    keccak256(
                        abi.encodePacked(
                            bytes1(0xd6),
                            bytes1(0x94),
                            deployer,
                            uint8(nonce)
                        )
                    )
                );
        }
        if (nonce <= 2 ** 8 - 1) {
            return
                addressFromLast20Bytes(
                    keccak256(
                        abi.encodePacked(
                            bytes1(0xd7),
                            bytes1(0x94),
                            deployer,
                            bytes1(0x81),
                            uint8(nonce)
                        )
                    )
                );
        }
        if (nonce <= 2 ** 16 - 1) {
            return
                addressFromLast20Bytes(
                    keccak256(
                        abi.encodePacked(
                            bytes1(0xd8),
                            bytes1(0x94),
                            deployer,
                            bytes1(0x82),
                            uint16(nonce)
                        )
                    )
                );
        }
        if (nonce <= 2 ** 24 - 1) {
            return
                addressFromLast20Bytes(
                    keccak256(
                        abi.encodePacked(
                            bytes1(0xd9),
                            bytes1(0x94),
                            deployer,
                            bytes1(0x83),
                            uint24(nonce)
                        )
                    )
                );
        }

        return
            addressFromLast20Bytes(
                keccak256(
                    abi.encodePacked(
                        bytes1(0xda),
                        bytes1(0x94),
                        deployer,
                        bytes1(0x84),
                        uint32(nonce)
                    )
                )
            );
    }

    function addressFromLast20Bytes(
        bytes32 bytesValue
    ) private pure returns (address) {
        return address(uint160(uint256(bytesValue)));
    }
}
