// SPDX-License-Identifier: MIT
// OpenZeppelin Contracts (last updated v5.1.0) (metatx/ERC2771Context.sol)

pragma solidity ^0.8.17;

import { Context } from "@openzeppelin/contracts/utils/Context.sol";
import { InvalidCallData } from "../Errors/GenericErrors.sol";
import { TransferrableOwnership } from "../Helpers/TransferrableOwnership.sol";

/**
 * @dev Context variant with ERC-2771 support.
 *
 * WARNING: Avoid using this pattern in contracts that rely in a specific calldata length as they'll
 * be affected by any forwarder whose `msg.data` is suffixed with the `from` address according to the ERC-2771
 * specification adding the address size in bytes (20) to the calldata size. An example of an unexpected
 * behavior could be an unintended fallback (or another function) invocation while trying to invoke the `receive`
 * function only accessible if `msg.data.length == 0`.
 *
 * WARNING: The usage of `delegatecall` in this contract is dangerous and may result in context corruption.
 * Any forwarded request to this contract triggering a `delegatecall` to itself will result in an invalid {_msgSender}
 * recovery.
 */
abstract contract ERC2771ContextCustom is Context, TransferrableOwnership {
    event TrustedForwardersUpdated(
        address[] forwarderAddresses,
        bool[] isTrusted
    );
    mapping(address => bool) private _trustedForwarders;

    /// @notice Constructor
    ///         We need to have a constructor to silence the compiler
    ///         However, we do not call the constructor of TransferrableOwnership here since the
    ///         contract is already initialized by WithdrawablePeriphery.sol and we cannot initialize twice
    constructor(address[] memory _trustedForwarderAddresses) {
        // update forwarder addresses
        for (uint i; i < _trustedForwarderAddresses.length; ) {
            _trustedForwarders[_trustedForwarderAddresses[i]] = true;

            unchecked {
                ++i;
            }
        }
    }

    /// @notice Updates the list of trusted forwarder addresses
    ///         A trusted forwarder is a relayer that must implement ERC2771 (= appends original msg.sender to calldata)
    /// @param _forwarderAddresses A list of addresses that should be updated
    /// @param _isTrusted The bool values that should be assigned for each address update
    function setTrustedForwarders(
        address[] memory _forwarderAddresses,
        bool[] memory _isTrusted
    ) public onlyOwner {
        // make sure parameters have same length to prevent unexpected behaviour
        if (_forwarderAddresses.length != _isTrusted.length)
            revert InvalidCallData();

        emit TrustedForwardersUpdated(_forwarderAddresses, _isTrusted);

        // update forwarder addresses
        for (uint i; i < _forwarderAddresses.length; ) {
            _trustedForwarders[_forwarderAddresses[i]] = _isTrusted[i];

            unchecked {
                ++i;
            }
        }
    }

    /// @notice Checks if an address is a trusted forwarder address
    /// @param _forwarder The address that should be checked if it's a trusted forwarder
    function isTrustedForwarder(
        address _forwarder
    ) public view virtual returns (bool) {
        return _trustedForwarders[_forwarder];
    }

    // ###### UNCHANGED CODE FROM OPENZEPPELIN CONTRACT #######

    /**
     * @dev Override for `msg.sender`. Defaults to the original `msg.sender` whenever
     * a call is not performed by the trusted forwarder or the calldata length is less than
     * 20 bytes (an address length).
     */
    function _msgSender() internal view virtual override returns (address) {
        uint256 calldataLength = msg.data.length;
        uint256 contextSuffixLength = _contextSuffixLength();
        if (
            isTrustedForwarder(msg.sender) &&
            calldataLength >= contextSuffixLength
        ) {
            return
                address(
                    bytes20(msg.data[calldataLength - contextSuffixLength:])
                );
        } else {
            return super._msgSender();
        }
    }

    /**
     * @dev Override for `msg.data`. Defaults to the original `msg.data` whenever
     * a call is not performed by the trusted forwarder or the calldata length is less than
     * 20 bytes (an address length).
     */
    function _msgData()
        internal
        view
        virtual
        override
        returns (bytes calldata)
    {
        uint256 calldataLength = msg.data.length;
        uint256 contextSuffixLength = _contextSuffixLength();
        if (
            isTrustedForwarder(msg.sender) &&
            calldataLength >= contextSuffixLength
        ) {
            return msg.data[:calldataLength - contextSuffixLength];
        } else {
            return super._msgData();
        }
    }

    /**
     * @dev ERC-2771 specifies the context as being a single address (20 bytes).
     */
    function _contextSuffixLength() internal view virtual returns (uint256) {
        return 20;
    }
}
