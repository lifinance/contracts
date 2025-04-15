// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

struct OutputDescription {
    /**
     * @dev Contract on the destination that tells whether an order was filled.
     */
    bytes32 remoteOracle;
    /**
     * @dev Contract on the destination that contains logic to resolve this output
     */
    bytes32 remoteFiller;
    /**
     * @dev The destination chain for this output.
     */
    uint256 chainId;
    /**
     * @dev The address of the token on the destination chain.
     */
    bytes32 token;
    /**
     * @dev The amount of the token to be sent.
     */
    uint256 amount;
    /**
     * @dev The address to receive the output tokens.
     */
    bytes32 recipient;
    /**
     * @dev Additional data that will be used to execute a call on the remote chain.
     * Is called on recipient.
     */
    bytes remoteCall;
    /**
     * @dev Non-particular data that is used to encode non-generic behaviour for a filler.
     */
    bytes fulfillmentContext;
}

/**
 * @notice Helper library for the Output description order type.
 * TYPE_PARTIAL: An incomplete type. Is missing a field.'
 * TYPE_STUB: Type has no subtypes.
 * TYPE: Is complete including sub-types.
 */
library OutputDescriptionType {
    //--- Inputs & Outputs Types ---//

    bytes internal constant OUTPUT_DESCRIPTION_TYPE_STUB =
        abi.encodePacked(
            "OutputDescription(bytes32 remoteOracle,bytes32 remoteFiller,uint256 chainId,bytes32 token,uint256 amount,bytes32 recipient,bytes remoteCall,bytes fulfillmentContext)"
        );

    bytes32 internal constant OUTPUT_DESCRIPTION_TYPE_HASH =
        keccak256(OUTPUT_DESCRIPTION_TYPE_STUB);

    function hashOutput(
        OutputDescription memory output
    ) internal pure returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    OUTPUT_DESCRIPTION_TYPE_HASH,
                    output.remoteOracle,
                    output.remoteFiller,
                    output.chainId,
                    output.token,
                    output.amount,
                    output.recipient,
                    keccak256(output.remoteCall),
                    keccak256(output.fulfillmentContext)
                )
            );
    }

    function hashOutputs(
        OutputDescription[] memory outputs
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
}

struct CatalystCompactOrder {
    address user;
    uint256 nonce;
    uint256 originChainId;
    uint32 expires;
    uint32 fillDeadline;
    address localOracle;
    uint256[2][] inputs;
    OutputDescription[] outputs;
}

/**
 * @notice Helper library for the Catalyst order type.
 * TYPE_PARTIAL: An incomplete type. Is missing a field.
 * TYPE_STUB: Type has no subtypes.
 * TYPE: Is complete including sub-types.
 */
library TheCompactOrderType {
    bytes internal constant CATALYST_WITNESS_TYPE_STUB =
        abi.encodePacked(
            "CatalystWitness(uint32 fillDeadline,address localOracle,OutputDescription[] outputs)"
        );

    bytes internal constant CATALYST_WITNESS_TYPE =
        abi.encodePacked(
            CATALYST_WITNESS_TYPE_STUB,
            OutputDescriptionType.OUTPUT_DESCRIPTION_TYPE_STUB
        );

    bytes32 internal constant CATALYST_WITNESS_TYPE_HASH =
        keccak256(CATALYST_WITNESS_TYPE);

    bytes internal constant BATCH_COMPACT_TYPE_PARTIAL =
        abi.encodePacked(
            "BatchCompact(address arbiter,address sponsor,uint256 nonce,uint256 expires,uint256[2][] idsAndAmounts,"
        );

    bytes internal constant CATALYST_BATCH_WITNESS_TYPES =
        abi.encodePacked(
            "CatalystWitness witness)",
            CATALYST_WITNESS_TYPE_STUB,
            OutputDescriptionType.OUTPUT_DESCRIPTION_TYPE_STUB
        );

    bytes internal constant CATALYST_BATCH_COMPACT_TYPE =
        abi.encodePacked(
            BATCH_COMPACT_TYPE_PARTIAL,
            CATALYST_BATCH_WITNESS_TYPES
        );

    bytes32 internal constant CATALYST_BATCH_COMPACT_TYPE_HASH =
        keccak256(CATALYST_BATCH_COMPACT_TYPE);

    /**
     * @notice This is the signed Catalyst witness structure. This allows us to more easily collect the order hash.
     * Notice that this is different to both the order data and the ERC7683 order.
     */
    struct CatalystWitness {
        uint32 fillDeadline;
        address localOracle;
        OutputDescription[] outputs;
    }

    function witnessHash(
        uint32 fillDeadline,
        address localOracle,
        OutputDescription[] memory outputs
    ) internal pure returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    CATALYST_WITNESS_TYPE_HASH,
                    fillDeadline,
                    localOracle,
                    OutputDescriptionType.hashOutputs(outputs)
                )
            );
    }
}
