// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

// solhint-disable-next-line no-unused-import
import { LibAsset } from "../Libraries/LibAsset.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { WithdrawablePeriphery } from "../Helpers/WithdrawablePeriphery.sol";
import { SafeTransferLib } from "solady/utils/SafeTransferLib.sol";

/// External wrapper interface
interface IWrapper {
    function deposit() external payable;

    // solhint-disable-next-line explicit-types
    function withdraw(uint wad) external;
}

/// @title TokenWrapper
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for wrapping and unwrapping tokens
/// @custom:version 1.2.0
contract TokenWrapper is WithdrawablePeriphery {
    uint256 private constant MAX_INT = 2 ** 256 - 1;
    address public wrappedToken;
    address public converter;

    /// Errors ///
    error WithdrawFailure();

    /// Constructor ///
    // solhint-disable-next-line no-empty-blocks
    constructor(
        address _wrappedToken,
        address _converter,
        address _owner
    ) WithdrawablePeriphery(_owner) {
        wrappedToken = _wrappedToken;
        converter = _converter;
    }

    /// External Methods ///

    /// @notice Wraps the native token
    function deposit() external payable {
        address wrapperAddress = converter != address(0)
            ? converter
            : wrappedToken;
        IWrapper(wrapperAddress).deposit{ value: msg.value }();
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
        address wrapperAddress = converter != address(0)
            ? converter
            : wrappedToken;

        // If converter is set, approve it to spend wrappedToken
        if (converter != address(0)) {
            LibAsset.maxApproveERC20(IERC20(wrappedToken), converter, wad);
        }

        IWrapper(wrapperAddress).withdraw(wad);
        SafeTransferLib.safeTransferETH(msg.sender, wad);
    }

    // Needs to be able to receive native on `withdraw`
    receive() external payable {}
}
