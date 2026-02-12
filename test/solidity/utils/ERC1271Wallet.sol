// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title ERC1271Wallet
/// @author LI.FI (https://li.fi)
/// @notice Minimal ERC-1271 wallet: returns magic value when signature recovers to the stored owner.
///         If DELEGATE_TO is set, isValidSignature is delegated to that contract instead of using the local implementation.
/// @custom:version 1.1.0
contract ERC1271Wallet {
    bytes4 private constant ERC1271_MAGIC = 0x1626ba7e;

    address public owner;
    /// @dev If non-zero, isValidSignature is forwarded to this contract (no local check).
    address public immutable DELEGATE_TO;

    /// @param _owner Owner address; used when DELEGATE_TO is zero to verify recovered signer.
    /// @param _delegateTo If non-zero, all isValidSignature calls are delegated here; local ECDSA check is not used.
    constructor(address _owner, address _delegateTo) {
        owner = _owner;
        DELEGATE_TO = _delegateTo;
    }

    function isValidSignature(
        bytes32 hash,
        bytes memory signature
    ) external view returns (bytes4) {
        if (DELEGATE_TO != address(0)) {
            (bool ok, bytes memory ret) = DELEGATE_TO.staticcall(
                abi.encodeWithSelector(
                    ERC1271Wallet.isValidSignature.selector,
                    hash,
                    signature
                )
            );
            if (!ok || ret.length < 4) return bytes4(0);
            return abi.decode(ret, (bytes4));
        }
        return _isValidSignatureLocal(hash, signature);
    }

    function _isValidSignatureLocal(
        bytes32 hash,
        bytes memory signature
    ) internal view returns (bytes4) {
        if (signature.length != 65) return bytes4(0);
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(add(signature, 32), 0))
            s := mload(add(add(signature, 32), 32))
            v := byte(0, mload(add(add(signature, 32), 64)))
        }
        if (v < 27) v += 27;
        address signer = ECDSA.recover(hash, v, r, s);
        return signer == owner ? ERC1271_MAGIC : bytes4(0);
    }
}
