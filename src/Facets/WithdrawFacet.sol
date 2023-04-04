// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { LibDiamond } from "../Libraries/LibDiamond.sol";
import { LibUtil } from "../Libraries/LibUtil.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";
import { LibAccess } from "../Libraries/LibAccess.sol";
import { NotAContract } from "../Errors/GenericErrors.sol";

/// @title Withdraw Facet
/// @author LI.FI (https://li.fi)
/// @notice Allows admin to withdraw funds that are kept in the contract by accident
contract WithdrawFacet {
    /// Errors ///

    error WithdrawFailed();

    /// Events ///

    event LogWithdraw(
        address indexed _assetAddress,
        address _to,
        uint256 amount
    );

    /// External Methods ///

    /// @notice Execute call data and withdraw asset.
    /// @param _callTo The address to execute the calldata on.
    /// @param _callData The data to execute.
    /// @param _assetAddress Asset to be withdrawn.
    /// @param _to address to withdraw to.
    /// @param _amount amount of asset to withdraw.
    function executeCallAndWithdraw(
        address payable _callTo,
        bytes calldata _callData,
        address _assetAddress,
        address _to,
        uint256 _amount
    ) external {
        if (msg.sender != LibDiamond.contractOwner()) {
            LibAccess.enforceAccessControl();
        }

        // Check if the _callTo is a contract
        bool success;
        bool isContract = LibAsset.isContract(_callTo);
        if (!isContract) revert NotAContract();

        // solhint-disable-next-line avoid-low-level-calls
        (success, ) = _callTo.call(_callData);

        if (success) {
            _withdrawAsset(_assetAddress, _to, _amount);
        } else {
            revert WithdrawFailed();
        }
    }

    /// @notice Withdraw asset.
    /// @param _assetAddress Asset to be withdrawn.
    /// @param _to address to withdraw to.
    /// @param _amount amount of asset to withdraw.
    function withdraw(
        address _assetAddress,
        address _to,
        uint256 _amount
    ) external {
        if (msg.sender != LibDiamond.contractOwner()) {
            LibAccess.enforceAccessControl();
        }
        _withdrawAsset(_assetAddress, _to, _amount);
    }

    /// Internal Methods ///

    /// @notice Withdraw asset.
    /// @param _assetAddress Asset to be withdrawn.
    /// @param _to address to withdraw to.
    /// @param _amount amount of asset to withdraw.
    function _withdrawAsset(
        address _assetAddress,
        address _to,
        uint256 _amount
    ) internal {
        address sendTo = (LibUtil.isZeroAddress(_to)) ? msg.sender : _to;
        LibAsset.transferAsset(_assetAddress, payable(sendTo), _amount);
        emit LogWithdraw(_assetAddress, sendTo, _amount);
    }
}
