// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { IPaxosTransit } from "lifi/Interfaces/IPaxosTransit.sol";
import { TestEIP712 } from "./TestEIP712.sol";

/// @title TestPaxosTransitBackendSig
/// @notice Quote-specific EIP-712 signature helpers for `PaxosTransitFacet` fork tests.
///         Signs `IPaxosTransit.Quote` structs against the real TransitStation's live
///         domain (name "TransitStation", version "1", current chainid, station address),
///         standing in for the Paxos backend after the station's quote signer has been
///         rotated to `quoteSignerPk` on the fork.
abstract contract TestPaxosTransitBackendSig is TestEIP712 {
    // Type strings copied verbatim from the verified TransitStation
    // (mainnet 0x49AAA987b1a7e9E4AE091dcD8332c39F322D7d28); the `route` member is
    // encoded as its own hashStruct per the EIP-712 spec.
    bytes32 private constant ROUTE_TYPEHASH =
        keccak256(
            "Route(uint32 destEID,address offerAsset,address wantAsset)"
        );
    bytes32 private constant QUOTE_TYPEHASH =
        keccak256(
            "Quote(Route route,uint256 offerAmount,address receiver,uint256 protocolFee,uint256 integratorFee,address integratorFeeReceiver,bytes32 distributorCode,uint256 deadline,bytes32 salt)Route(uint32 destEID,address offerAsset,address wantAsset)"
        );

    /// @dev Test quote-signer private key (tests configure in `setUp()` and rotate the
    ///      station's signer to the derived `quoteSignerAddress`).
    uint256 internal quoteSignerPk;
    address internal quoteSignerAddress;

    function _hashQuote(
        IPaxosTransit.Quote memory _quote
    ) internal pure returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    QUOTE_TYPEHASH,
                    keccak256(
                        abi.encode(
                            ROUTE_TYPEHASH,
                            _quote.route.destEID,
                            _quote.route.offerAsset,
                            _quote.route.wantAsset
                        )
                    ),
                    _quote.offerAmount,
                    _quote.receiver,
                    _quote.protocolFee,
                    _quote.integratorFee,
                    _quote.integratorFeeReceiver,
                    _quote.distributorCode,
                    _quote.deadline,
                    _quote.salt
                )
            );
    }

    function _paxosQuoteDigest(
        IPaxosTransit.Quote memory _quote,
        address _station
    ) internal view returns (bytes32) {
        return
            _digest(
                _domainSeparator(
                    "TransitStation",
                    "1",
                    block.chainid,
                    _station
                ),
                _hashQuote(_quote)
            );
    }

    function _signPaxosQuote(
        IPaxosTransit.Quote memory _quote,
        address _station
    ) internal view returns (bytes memory) {
        return _signDigest(quoteSignerPk, _paxosQuoteDigest(_quote, _station));
    }
}
