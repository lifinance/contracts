// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { WithdrawablePeriphery } from "../Helpers/WithdrawablePeriphery.sol";
import { InvalidConfig } from "../Errors/GenericErrors.sol";

/// @title IStETH
/// @notice External interface for Lido's stETH contract which supports wrapping and unwrapping wstETH
interface IStETH is IERC20 {
    /// @notice Unwraps wstETH into stETH
    /// @param amount The amount of wstETH to unwrap
    function wrap(uint256 amount) external;

    /// @notice Wraps stETH into wstETH
    /// @param amount The amount of stETH to wrap
    function unwrap(uint256 amount) external;
}

/// @title LidoWrapper
/// @author LI.FI (https://li.fi)
/// @notice Wraps and unwraps Lido’s wstETH and stETH tokens
/// @dev Be aware that Lido's L2 `wrap`/`unwrap` naming is reversed from the typical expectation.
/// @dev Any stETH or wstETH tokens sent directly to the contract can be irrecoverably swept by MEV bots
/// @custom:version 1.0.0
contract LidoWrapper is WithdrawablePeriphery {
    /// @notice Reference to the L2 stETH contract
    IStETH public immutable ST_ETH;

    /// @notice Address of the wstETH token contract
    address public immutable WST_ETH_ADDRESS;

    error ContractNotYetReadyForMainnet();

    /// @notice Constructor
    /// @param _stETHAddress The address of the stETH token on L2
    /// @param _wstETHAddress The address of the bridged wstETH token on L2
    /// @param _owner The address of the contract owner
    constructor(
        address _stETHAddress,
        address _wstETHAddress,
        address _owner
    ) WithdrawablePeriphery(_owner) {
        if (
            _stETHAddress == address(0) ||
            _wstETHAddress == address(0) ||
            _owner == address(0)
        ) revert InvalidConfig();

        ST_ETH = IStETH(_stETHAddress);
        WST_ETH_ADDRESS = _wstETHAddress;

        // the wrap/unwrap functions are different on mainnet
        if (block.chainid == 1) revert ContractNotYetReadyForMainnet();

        // Approve stETH contract to pull wstETH from this contract
        IERC20(WST_ETH_ADDRESS).approve(address(ST_ETH), type(uint256).max);
    }

    /// @notice Wraps stETH into wstETH
    /// @dev Transfers `_amount` stETH from caller, unwraps it via the stETH contract (which yields wstETH), and returns wstETH to the caller.
    /// @param _amount The amount of stETH to wrap into wstETH
    function wrapStETHToWstETH(uint256 _amount) external {
        // Pull stETH from sender
        IERC20(address(ST_ETH)).transferFrom(
            msg.sender,
            address(this),
            _amount
        );

        // Call `unwrap` on stETH contract to get wstETH (naming is inverted) with full stETH contract balance
        // This contract is designed to not hold funds so sending full balance is not a problem
        uint256 stETHBalance = IERC20(address(ST_ETH)).balanceOf(
            address(this)
        );
        ST_ETH.unwrap(stETHBalance);

        // Transfer resulting wstETH to sender
        uint256 balance = IERC20(WST_ETH_ADDRESS).balanceOf(address(this));
        IERC20(WST_ETH_ADDRESS).transfer(msg.sender, balance);
    }

    /// @notice Unwraps wstETH into stETH
    /// @dev Transfers `_amount` wstETH from caller, wraps it via stETH contract (yielding stETH), and returns stETH to the caller.
    /// @param _amount The amount of wstETH to unwrap into stETH
    function unwrapWstETHToStETH(uint256 _amount) external {
        // Pull wstETH from sender
        IERC20(WST_ETH_ADDRESS).transferFrom(
            msg.sender,
            address(this),
            _amount
        );

        // Call `wrap` on stETH contract to get stETH (again, inverted naming)
        ST_ETH.wrap(_amount);

        // Transfer resulting stETH to sender
        uint256 balance = IERC20(address(ST_ETH)).balanceOf(address(this));
        IERC20(address(ST_ETH)).transfer(msg.sender, balance);
    }
}
