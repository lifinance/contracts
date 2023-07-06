// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface SGEthVault is IERC20 {
    function deposit() external payable;

    function withdraw(uint256 amount) external;
}
