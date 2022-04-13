// SPDX-License-Identifier: MIT
pragma solidity ^0.8.7;

import "../Libraries/LibStorage.sol";
import "../Libraries/LibDiamond.sol";

/**
 * @title Optics Router Facet
 * @author LI.FI (https://li.fi)
 * @notice Facet contract for managing approved DEXs to be used in swaps.
 */
contract DexManagerFacet {
    event DexAdded(address indexed dexAddress);
    event DexRemoved(address indexed dexAddress);
    event FunctionSignatureApprovalChanged(bytes32 indexed functionSignature, bool indexed approved);

    /// Storage ///

    LibStorage internal s;

    /// Errors ///

    error InvalidConfig();

    /// Public Methods ///

    /// @notice Register the address of a DEX contract to be approved for swapping.
    /// @param _dex The address of the DEX contract to be approved.
    function addDex(address _dex) external {
        LibDiamond.enforceIsContractOwner();
        _checkAddress(_dex);

        mapping(address => bool) storage dexAllowlist = s.dexAllowlist;
        if (dexAllowlist[_dex]) return;

        dexAllowlist[_dex] = true;
        s.dexs.push(_dex);
        emit DexAdded(_dex);
    }

    /// @notice Batch register the addresss of DEX contracts to be approved for swapping.
    /// @param _dexs The addresses of the DEX contracts to be approved.
    function batchAddDex(address[] calldata _dexs) external {
        LibDiamond.enforceIsContractOwner();
        mapping(address => bool) storage dexAllowlist = s.dexAllowlist;
        uint256 length = _dexs.length;

        for (uint256 i = 0; i < length; i++) {
            _checkAddress(_dexs[i]);
            if (dexAllowlist[_dexs[i]]) continue;
            dexAllowlist[_dexs[i]] = true;
            s.dexs.push(_dexs[i]);
            emit DexAdded(_dexs[i]);
        }
    }

    /// @notice Unregister the address of a DEX contract approved for swapping.
    /// @param _dex The address of the DEX contract to be unregistered.
    function removeDex(address _dex) external {
        LibDiamond.enforceIsContractOwner();
        _checkAddress(_dex);

        mapping(address => bool) storage dexAllowlist = s.dexAllowlist;
        address[] storage storageDexes = s.dexs;

        if (!dexAllowlist[_dex]) {
            return;
        }
        dexAllowlist[_dex] = false;

        uint256 length = storageDexes.length;
        for (uint256 i = 0; i < length; i++) {
            if (storageDexes[i] == _dex) {
                _removeDex(i);
                return;
            }
        }
    }

    /// @notice Batch unregister the addresses of DEX contracts approved for swapping.
    /// @param _dexs The addresses of the DEX contracts to be unregistered.
    function batchRemoveDex(address[] calldata _dexs) external {
        LibDiamond.enforceIsContractOwner();
        mapping(address => bool) storage dexAllowlist = s.dexAllowlist;
        address[] storage storageDexes = s.dexs;

        uint256 ilength = _dexs.length;
        uint256 jlength = storageDexes.length;
        for (uint256 i = 0; i < ilength; i++) {
            _checkAddress(_dexs[i]);
            if (!dexAllowlist[_dexs[i]]) {
                continue;
            }
            dexAllowlist[_dexs[i]] = false;
            for (uint256 j = 0; j < jlength; j++) {
                if (storageDexes[j] == _dexs[i]) {
                    _removeDex(j);
                    break;
                }
            }
        }
    }

    function setFunctionApprovalBySignature(bytes32 _signature, bool approval) external {
        LibDiamond.enforceIsContractOwner();
        s.dexFuncSignatureAllowList[_signature] = approval;
        emit FunctionSignatureApprovalChanged(_signature, approval);
    }

    function batchSetFunctionApprovalBySignature(bytes32[] calldata _signatures, bool approval) external {
        LibDiamond.enforceIsContractOwner();
        mapping(bytes32 => bool) storage dexFuncSignatureAllowList = s.dexFuncSignatureAllowList;
        uint256 length = _signatures.length;
        for (uint256 i = 0; i < length; i++) {
            bytes32 _signature = _signatures[i];
            dexFuncSignatureAllowList[_signature] = approval;
            emit FunctionSignatureApprovalChanged(_signature, approval);
        }
    }

    function isFunctionApproved(bytes32 _signature) public view returns (bool) {
        return s.dexFuncSignatureAllowList[_signature];
    }

    /// @notice Returns a list of all approved DEX addresses.
    function approvedDexs() external view returns (address[] memory) {
        return s.dexs;
    }

    /// Private Methods ///

    /// @dev Contains business logic for removing a DEX address.
    function _removeDex(uint256 index) private {
        address[] storage storageDexes = s.dexs;
        address toRemove = storageDexes[index];
        // Move the last element into the place to delete
        storageDexes[index] = storageDexes[storageDexes.length - 1];
        // Remove the last element
        storageDexes.pop();
        emit DexRemoved(toRemove);
    }

    /// @dev Contains business logic for validating a DEX address.
    function _checkAddress(address _dex) private pure {
        if (_dex == 0x0000000000000000000000000000000000000000) {
            revert InvalidConfig();
        }
    }
}
