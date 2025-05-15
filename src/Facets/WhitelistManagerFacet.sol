// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import { LibDiamond } from "../Libraries/LibDiamond.sol";
import { LibAccess } from "../Libraries/LibAccess.sol";
import { LibAllowList } from "../Libraries/LibAllowList.sol";
import { IWhitelistManagerFacet } from "../Interfaces/IWhitelistManagerFacet.sol";
import { CannotAuthoriseSelf } from "../Errors/GenericErrors.sol";

/// @title Whitelist Manager Facet
/// @author LI.FI (https://li.fi)
/// @notice Facet contract for managing whitelisted addresses for various protocol interactions.
/// @custom:version 1.0.3
contract WhitelistManagerFacet is IWhitelistManagerFacet {
    /// External Methods ///

    /// @inheritdoc IWhitelistManagerFacet
    function addToWhitelist(address _address) external {
        if (msg.sender != LibDiamond.contractOwner()) {
            LibAccess.enforceAccessControl();
        }

        LibAllowList.addAllowedContract(_address);

        emit AddressWhitelisted(_address);
    }

    /// @inheritdoc IWhitelistManagerFacet
    function batchAddToWhitelist(address[] calldata _addresses) external {
        if (msg.sender != LibDiamond.contractOwner()) {
            LibAccess.enforceAccessControl();
        }
        uint256 length = _addresses.length;

        for (uint256 i = 0; i < length; ) {
            address addr = _addresses[i];
            if (addr == address(this)) {
                revert CannotAuthoriseSelf();
            }
            if (LibAllowList.contractIsAllowed(addr)) {
                unchecked {
                    ++i;
                }
                continue;
            }
            LibAllowList.addAllowedContract(addr);
            emit AddressWhitelisted(addr);
            unchecked {
                ++i;
            }
        }
    }

    /// @inheritdoc IWhitelistManagerFacet
    function removeFromWhitelist(address _address) external {
        if (msg.sender != LibDiamond.contractOwner()) {
            LibAccess.enforceAccessControl();
        }
        LibAllowList.removeAllowedContract(_address);
        emit AddressRemoved(_address);
    }

    /// @inheritdoc IWhitelistManagerFacet
    function batchRemoveFromWhitelist(address[] calldata _addresses) external {
        if (msg.sender != LibDiamond.contractOwner()) {
            LibAccess.enforceAccessControl();
        }
        uint256 length = _addresses.length;
        for (uint256 i = 0; i < length; ) {
            LibAllowList.removeAllowedContract(_addresses[i]);
            emit AddressRemoved(_addresses[i]);
            unchecked {
                ++i;
            }
        }
    }

    /// @inheritdoc IWhitelistManagerFacet
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

    /// @inheritdoc IWhitelistManagerFacet
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

    /// @inheritdoc IWhitelistManagerFacet
    function isFunctionApproved(
        bytes4 _signature
    ) public view returns (bool approved) {
        return LibAllowList.selectorIsAllowed(_signature);
    }

    /// @inheritdoc IWhitelistManagerFacet
    function getWhitelistedAddresses()
        external
        view
        returns (address[] memory addresses)
    {
        return LibAllowList.getAllowedContracts();
    }

    /// @inheritdoc IWhitelistManagerFacet
    function isAddressWhitelisted(
        address _address
    ) public view returns (bool approved) {
        return LibAllowList.contractIsAllowed(_address);
    }
}
