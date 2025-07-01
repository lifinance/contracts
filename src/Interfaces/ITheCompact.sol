// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;
interface ITheCompact {
    /**
     * @notice External function for depositing ERC20 tokens and simultaneously registering a
     * batch compact on behalf of someone else. The caller must directly approve The Compact
     * to transfer a sufficient amount of the ERC20 token on its behalf. The ERC6909 token amount
     * received by designated recipient the caller is derived from the difference between the
     * starting and ending balance held in the resource lock, which may differ from the amount
     * transferred depending on the implementation details of the respective token.
     * @dev The final ERC6909 token amounts will be substituted into the compact which will be
     * registered with the returned registeredAmounts instead of the provided idsAndAmounts.
     * Ensure the claim is processed using either the registeredAmounts or the ERC6909 transfer events.
     * This is especially important for fee-on-transfer tokens.
     * @param recipient         The recipient of the ERC6909 token.
     * @param idsAndAmounts     The address of the ERC20 token to deposit.
     * @param arbiter           The account tasked with verifying and submitting the claim.
     * @param nonce             A parameter to enforce replay protection, scoped to allocator.
     * @param expires           The time at which the claim expires.
     * @param typehash          The EIP-712 typehash associated with the registered compact.
     * @param witness           Hash of the witness data.
     * @return claimhash        Hash of the claim. Can be used to verify the expected claim was registered.
     * @return registeredAmounts Array containing the final minted amount of each id.
     */
    function batchDepositAndRegisterFor(
        address recipient,
        uint256[2][] calldata idsAndAmounts,
        address arbiter,
        uint256 nonce,
        uint256 expires,
        bytes32 typehash,
        bytes32 witness
    )
        external
        payable
        returns (bytes32 claimhash, uint256[] memory registeredAmounts);

    /**
     * @notice External function for registering an allocator. Can be called by anyone if one
     * of three conditions is met: the caller is the allocator address being registered, the
     * allocator address contains code, or a proof is supplied representing valid create2
     * deployment parameters that resolve to the supplied allocator address.
     * @param allocator    The address to register as an allocator.
     * @param proof        An 85-byte value containing create2 address derivation parameters (0xff ++ factory ++ salt ++ initcode hash).
     * @return allocatorId A unique identifier assigned to the registered allocator.
     */
    function __registerAllocator(
        address allocator,
        bytes calldata proof
    ) external returns (uint96 allocatorId);

    function DOMAIN_SEPARATOR() external view returns (bytes32);
}
