// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.17;

import { LibAsset } from "../Libraries/LibAsset.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// External wrapper interface
interface IWrapper {
    function deposit() external payable;

    function withdraw(uint wad) external;
}

/// @title TokenWrapper
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for wrapping and unwrapping tokens
/// @custom:version 1.0.0
contract TokenWrapper {
    uint256 private constant MAX_INT = 2 ** 256 - 1;
    address public wrappedToken;

    /// Errors ///
    error WithdrawFailure();

    /// Constructor ///
    // solhint-disable-next-line no-empty-blocks
    constructor(address _wrappedToken) {
        wrappedToken = _wrappedToken;
        IERC20(wrappedToken).approve(address(this), MAX_INT);
    }

    /// External Methods ///

    /// @notice Wraps the native token
    function deposit() external payable {
        IWrapper(wrappedToken).deposit{ value: msg.value }();
        IERC20(wrappedToken).transfer(msg.sender, msg.value);
    }

    /// @notice Unwraps all the caller's balance of wrapped token
    function withdraw() external {
        // While in a general purpose contract it would make sense
        // to have `wad` equal to the minimum between the balance and the
        // given allowance, in our specific usecase allowance is always
        // nearly MAX_UINT256. Using the balance only is a gas optimisation.
        uint256 wad = IERC20(wrappedToken).balanceOf(msg.sender);
        IERC20(wrappedToken).transferFrom(msg.sender, address(this), wad);
        IWrapper(wrappedToken).withdraw(wad);
        (bool success, ) = payable(msg.sender).call{ value: wad }("");
        if (!success) {
            revert WithdrawFailure();
        }
    }

    // Needs to be able to receive native on `withdraw`
    receive() external payable {}
}
