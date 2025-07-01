// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

struct MandateOutput {
    /// @dev Oracle implementation responsible for collecting the proof from settler on output chain.
    bytes32 oracle;
    /// @dev Output Settler on the output chain responsible for settling the output payment.
    bytes32 settler;
    uint256 chainId;
    bytes32 token;
    uint256 amount;
    bytes32 recipient;
    /// @dev Data that will be delivered to recipient through the settlement callback on the output chain. Can be used
    /// to schedule additional actions.
    bytes call;
    /// @dev Additional output context for the output settlement, encoding order types or other information.
    bytes context;
}

/**
 * @notice Helper library for the Output description order type.
 * TYPE_PARTIAL: An incomplete type. Is missing a field.'
 * TYPE_STUB: Type has no subtypes.
 * TYPE: Is complete including sub-types.
 */
library MandateOutputType {
    //--- Outputs Types ---//

    bytes internal constant MANDATE_OUTPUT_TYPE_STUB =
        bytes(
            "MandateOutput(bytes32 oracle,bytes32 settler,uint256 chainId,bytes32 token,uint256 amount,bytes32 recipient,bytes call,bytes context)"
        );

    bytes32 internal constant MANDATE_OUTPUT_TYPE_HASH =
        keccak256(MANDATE_OUTPUT_TYPE_STUB);

    function hashOutput(
        MandateOutput calldata output
    ) internal pure returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    MANDATE_OUTPUT_TYPE_HASH,
                    output.oracle,
                    output.settler,
                    output.chainId,
                    output.token,
                    output.amount,
                    output.recipient,
                    keccak256(output.call),
                    keccak256(output.context)
                )
            );
    }

    function hashOutputs(
        MandateOutput[] calldata outputs
    ) internal pure returns (bytes32) {
        unchecked {
            bytes memory currentHash = new bytes(32 * outputs.length);

            for (uint256 i = 0; i < outputs.length; ++i) {
                bytes32 outputHash = hashOutput(outputs[i]);
                assembly {
                    mstore(
                        add(add(currentHash, 0x20), mul(i, 0x20)),
                        outputHash
                    )
                }
            }
            return keccak256(currentHash);
        }
    }

    // Memory copy of the above:
    function hashOutputM(
        MandateOutput memory output
    ) internal pure returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    MANDATE_OUTPUT_TYPE_HASH,
                    output.oracle,
                    output.settler,
                    output.chainId,
                    output.token,
                    output.amount,
                    output.recipient,
                    keccak256(output.call),
                    keccak256(output.context)
                )
            );
    }

    function hashOutputsM(
        MandateOutput[] memory outputs
    ) internal pure returns (bytes32) {
        unchecked {
            bytes memory currentHash = new bytes(32 * outputs.length);

            for (uint256 i = 0; i < outputs.length; ++i) {
                bytes32 outputHash = hashOutputM(outputs[i]);
                assembly {
                    mstore(
                        add(add(currentHash, 0x20), mul(i, 0x20)),
                        outputHash
                    )
                }
            }
            return keccak256(currentHash);
        }
    }
}

struct StandardOrder {
    address user;
    uint256 nonce;
    uint256 originChainId;
    uint32 expires;
    uint32 fillDeadline;
    address localOracle;
    uint256[2][] inputs;
    MandateOutput[] outputs;
}

/**
 * @notice This is the signed Compact witness structure. This allows us to more easily collect the order hash.
 * Notice that this is different to both the order data and the ERC7683 order.
 */
struct Mandate {
    uint32 fillDeadline;
    address localOracle;
    MandateOutput[] outputs;
}

/**
 * @notice Helper library for the LIFIIntent order type.
 * TYPE_PARTIAL: An incomplete type. Is missing a field.
 * TYPE_STUB: Type has no subtypes.
 * TYPE: Is complete including sub-types.
 */
library StandardOrderType {
    function orderIdentifier(
        StandardOrder calldata order
    ) internal view returns (bytes32) {
        return
            keccak256(
                abi.encodePacked(
                    block.chainid,
                    address(this),
                    order.user,
                    order.nonce,
                    order.expires,
                    order.fillDeadline,
                    order.localOracle,
                    order.inputs,
                    abi.encode(order.outputs)
                )
            );
    }

    /// @dev TheCompact needs us to provide the type without the last ")"
    bytes internal constant BATCH_COMPACT_SUB_TYPES =
        bytes(
            "uint32 fillDeadline,address localOracle,MandateOutput[] outputs)MandateOutput(bytes32 oracle,bytes32 settler,uint256 chainId,bytes32 token,uint256 amount,bytes32 recipient,bytes call,bytes context"
        );

    /// @dev For hashing of our subtypes, we need proper types.
    bytes internal constant LIFI_INTENT_WITNESS_TYPE =
        abi.encodePacked(
            "Mandate(uint32 fillDeadline,address localOracle,MandateOutput[] outputs)MandateOutput(bytes32 oracle,bytes32 settler,uint256 chainId,bytes32 token,uint256 amount,bytes32 recipient,bytes call,bytes context)"
        );
    bytes32 internal constant LIFI_INTENT_WITNESS_TYPE_HASH =
        keccak256(LIFI_INTENT_WITNESS_TYPE);

    /**
     * @notice Computes the Compact witness of derived from a StandardOrder
     * @param order StandardOrder to derived the witness from.
     * @return witness hash.
     */
    function witnessHash(
        StandardOrder calldata order
    ) internal pure returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    LIFI_INTENT_WITNESS_TYPE_HASH,
                    order.fillDeadline,
                    order.localOracle,
                    MandateOutputType.hashOutputs(order.outputs)
                )
            );
    }
}

/**
 * @notice Governance fee timelock
 * Allows for safely setting and changing a governance fee through a built in time-lock. Also provides a generic
 * function to compute the the impact of the governance fee on an amount.
 */
library RegisterIntentLib {
    error DeadlinePassed();
    error WrongChain(uint256 expected, uint256 provided);

    bytes32 internal constant STANDARD_ORDER_BATCH_COMPACT_TYPE_HASH =
        keccak256(
            bytes(
                "BatchCompact(address arbiter,address sponsor,uint256 nonce,uint256 expires,Lock[] commitments,Mandate mandate)Lock(bytes12 lockTag,address token,uint256 amount)Mandate(uint32 fillDeadline,address localOracle,MandateOutput[] outputs)MandateOutput(bytes32 oracle,bytes32 settler,uint256 chainId,bytes32 token,uint256 amount,bytes32 recipient,bytes call,bytes context)"
            )
        );

    // Copy from OIF implementation with elements in memory for usage inside other contracts constructing the
    // StandardOrder.
    function witnessHash(
        uint32 fillDeadline,
        address inputOracle,
        MandateOutput[] memory outputs
    ) internal pure returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    StandardOrderType.LIFI_INTENT_WITNESS_TYPE_HASH,
                    fillDeadline,
                    inputOracle,
                    MandateOutputType.hashOutputsM(outputs)
                )
            );
    }

    function _validateExpiry(
        uint32 fillDeadline,
        uint32 expires
    ) internal view {
        // Check if the fill deadline has been passed
        if (block.timestamp > fillDeadline) revert DeadlinePassed();
        // Check if expiry has been passed
        if (block.timestamp > expires) revert DeadlinePassed();
    }

    function getLocksHash(
        uint256[2][] memory idsAndAmounts
    ) public pure returns (bytes32) {
        unchecked {
            uint256 numIdsAndAmounts = idsAndAmounts.length;
            bytes memory currentHash = new bytes(32 * numIdsAndAmounts);
            for (uint256 i; i < numIdsAndAmounts; ++i) {
                uint256[2] memory idsAndAmount = idsAndAmounts[i];
                bytes32 lockHash = keccak256(
                    abi.encode(
                        keccak256(
                            bytes(
                                "Lock(bytes12 lockTag,address token,uint256 amount)"
                            )
                        ),
                        bytes12(bytes32(idsAndAmount[0])),
                        address(uint160(idsAndAmount[0])),
                        idsAndAmount[1]
                    )
                );
                assembly ("memory-safe") {
                    mstore(add(add(currentHash, 0x20), mul(i, 0x20)), lockHash)
                }
            }

            return keccak256(currentHash);
        }
    }

    function compactClaimHash(
        address settler,
        StandardOrder memory order
    ) internal pure returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    STANDARD_ORDER_BATCH_COMPACT_TYPE_HASH,
                    settler,
                    order.user,
                    order.nonce,
                    order.expires,
                    getLocksHash(order.inputs),
                    witnessHash(
                        order.fillDeadline,
                        order.localOracle,
                        order.outputs
                    )
                )
            );
    }
}
