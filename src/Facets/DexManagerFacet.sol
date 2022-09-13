// SPDX-License-Identifier: MIT
pragma solidity 0.8.13;

import { LibDiamond } from "../Libraries/LibDiamond.sol";
import { LibAccess } from "../Libraries/LibAccess.sol";
import { LibAllowList } from "../Libraries/LibAllowList.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";
import { CannotAuthoriseSelf } from "../Errors/GenericErrors.sol";

/// @title Dex Manager Facet
/// @author LI.FI (https://li.fi)
/// @notice Facet contract for managing approved DEXs to be used in swaps.
contract DexManagerFacet {
    /// Events ///

    event DexAdded(address indexed dexAddress);
    event DexRemoved(address indexed dexAddress);
    event FunctionSignatureApprovalChanged(bytes4 indexed functionSignature, bool indexed approved);

    /// External Methods ///

    /// @notice Register the address of a DEX contract to be approved for swapping.
    /// @param _dex The address of the DEX contract to be approved.
    function addDex(address _dex) external {
        if (msg.sender != LibDiamond.contractOwner()) {
            LibAccess.enforceAccessControl();
        }

        if (_dex == address(this)) {
            revert CannotAuthoriseSelf();
        }

        LibAllowList.addAllowedContract(_dex);

        emit DexAdded(_dex);
    }

    /// @notice Batch register the address of DEX contracts to be approved for swapping.
    /// @param _dexs The addresses of the DEX contracts to be approved.
    function batchAddDex(address[] calldata _dexs) external {
        if (msg.sender != LibDiamond.contractOwner()) {
            LibAccess.enforceAccessControl();
        }
        uint256 length = _dexs.length;

        for (uint256 i = 0; i < length; i++) {
            address dex = _dexs[i];
            if (dex == address(this)) {
                revert CannotAuthoriseSelf();
            }
            if (LibAllowList.contractIsAllowed(dex)) continue;
            LibAllowList.addAllowedContract(dex);
            emit DexAdded(dex);
        }
    }

    /// @notice Unregister the address of a DEX contract approved for swapping.
    /// @param _dex The address of the DEX contract to be unregistered.
    function removeDex(address _dex) external {
        if (msg.sender != LibDiamond.contractOwner()) {
            LibAccess.enforceAccessControl();
        }

        LibAllowList.removeAllowedContract(_dex);
        emit DexRemoved(_dex);
    }

    /// @notice Batch unregister the addresses of DEX contracts approved for swapping.
    /// @param _dexs The addresses of the DEX contracts to be unregistered.
    function batchRemoveDex(address[] calldata _dexs) external {
        if (msg.sender != LibDiamond.contractOwner()) {
            LibAccess.enforceAccessControl();
        }

        uint256 length = _dexs.length;
        for (uint256 i = 0; i < length; i++) {
            LibAllowList.removeAllowedContract(_dexs[i]);
            emit DexRemoved(_dexs[i]);
        }
    }

    /// @notice Adds/removes a specific function signature to/from the allowlist
    /// @param _signature the function signature to allow/disallow
    /// @param _approval whether the function signature should be allowed
    function setFunctionApprovalBySignature(bytes4 _signature, bool _approval) external {
        if (msg.sender != LibDiamond.contractOwner()) {
            LibAccess.enforceAccessControl();
        }

        if (_approval) {
            LibAllowList.addAllowedSelector(_signature);
        } else {
            LibAllowList.removeAllowedSelector(_signature);
        }

        emit FunctionSignatureApprovalChanged(_signature, _approval);
    }

    /// @notice Batch Adds/removes a specific function signature to/from the allowlist
    /// @param _signatures the function signatures to allow/disallow
    /// @param _approval whether the function signatures should be allowed
    function batchSetFunctionApprovalBySignature(bytes4[] calldata _signatures, bool _approval) external {
        if (msg.sender != LibDiamond.contractOwner()) {
            LibAccess.enforceAccessControl();
        }
        uint256 length = _signatures.length;
        for (uint256 i = 0; i < length; i++) {
            bytes4 _signature = _signatures[i];
            if (_approval) {
                LibAllowList.addAllowedSelector(_signature);
            } else {
                LibAllowList.removeAllowedSelector(_signature);
            }
            emit FunctionSignatureApprovalChanged(_signature, _approval);
        }
    }

    /// @notice Returns whether a function signature is approved
    /// @param _signature the function signature to query
    /// @return approved Approved or not
    function isFunctionApproved(bytes4 _signature) public view returns (bool approved) {
        return LibAllowList.selectorIsAllowed(_signature);
    }

    /// @notice Returns a list of all approved DEX addresses.
    /// @return addresses List of approved DEX addresses
    function approvedDexs() external view returns (address[] memory addresses) {
        return LibAllowList.getAllowedContracts();
    }
}
