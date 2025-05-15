// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import { LibDiamond } from "../Libraries/LibDiamond.sol";
import { LibAccess } from "../Libraries/LibAccess.sol";
import { LibAllowList } from "../Libraries/LibAllowList.sol";
import { IDexManagerFacet } from "../Interfaces/IDexManagerFacet.sol";
import { CannotAuthoriseSelf } from "../Errors/GenericErrors.sol";

/// @title Dex Manager Facet
/// @author LI.FI (https://li.fi)
/// @notice Facet contract for managing approved DEXs to be used in swaps.
/// @custom:version 1.0.3
contract DexManagerFacet is IDexManagerFacet {
    /// External Methods ///

    /// @inheritdoc IDexManagerFacet
    function addDex(address _dex) external {
        if (msg.sender != LibDiamond.contractOwner()) {
            LibAccess.enforceAccessControl();
        }

        LibAllowList.addAllowedContract(_dex);

        emit DexAdded(_dex);
    }

    /// @inheritdoc IDexManagerFacet
    function batchAddDex(address[] calldata _dexs) external {
        if (msg.sender != LibDiamond.contractOwner()) {
            LibAccess.enforceAccessControl();
        }
        uint256 length = _dexs.length;

        for (uint256 i = 0; i < length; ) {
            address dex = _dexs[i];
            if (dex == address(this)) {
                revert CannotAuthoriseSelf();
            }
            if (LibAllowList.contractIsAllowed(dex)) {
                unchecked {
                    ++i;
                }
                continue;
            }
            LibAllowList.addAllowedContract(dex);
            emit DexAdded(dex);
            unchecked {
                ++i;
            }
        }
    }

    /// @inheritdoc IDexManagerFacet
    function removeDex(address _dex) external {
        if (msg.sender != LibDiamond.contractOwner()) {
            LibAccess.enforceAccessControl();
        }
        LibAllowList.removeAllowedContract(_dex);
        emit DexRemoved(_dex);
    }

    /// @inheritdoc IDexManagerFacet
    function batchRemoveDex(address[] calldata _dexs) external {
        if (msg.sender != LibDiamond.contractOwner()) {
            LibAccess.enforceAccessControl();
        }
        uint256 length = _dexs.length;
        for (uint256 i = 0; i < length; ) {
            LibAllowList.removeAllowedContract(_dexs[i]);
            emit DexRemoved(_dexs[i]);
            unchecked {
                ++i;
            }
        }
    }

    /// @inheritdoc IDexManagerFacet
    function setFunctionApprovalBySignature(
        bytes4 _signature,
        bool _approval
    ) external {
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

    /// @inheritdoc IDexManagerFacet
    function batchSetFunctionApprovalBySignature(
        bytes4[] calldata _signatures,
        bool _approval
    ) external {
        if (msg.sender != LibDiamond.contractOwner()) {
            LibAccess.enforceAccessControl();
        }
        uint256 length = _signatures.length;
        for (uint256 i = 0; i < length; ) {
            bytes4 _signature = _signatures[i];
            if (_approval) {
                LibAllowList.addAllowedSelector(_signature);
            } else {
                LibAllowList.removeAllowedSelector(_signature);
            }
            emit FunctionSignatureApprovalChanged(_signature, _approval);
            unchecked {
                ++i;
            }
        }
    }

    /// @inheritdoc IDexManagerFacet
    function isFunctionApproved(
        bytes4 _signature
    ) public view returns (bool approved) {
        return LibAllowList.selectorIsAllowed(_signature);
    }

    /// @inheritdoc IDexManagerFacet
    function approvedDexs()
        external
        view
        returns (address[] memory addresses)
    {
        return LibAllowList.getAllowedContracts();
    }

    /// @inheritdoc IDexManagerFacet
    function isDexApproved(
        address _contract
    ) public view returns (bool approved) {
        return LibAllowList.contractIsAllowed(_contract);
    }
}
