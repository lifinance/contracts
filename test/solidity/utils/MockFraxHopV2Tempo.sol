// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { IFraxHopV2, IFraxOFT, ITipFeeManager } from "lifi/Interfaces/IFraxHopV2.sol";

/// @title IERC20Like
/// @notice Minimal ERC20 surface used by the Tempo mock hop to pull tokens
interface IERC20Like {
    function transferFrom(
        address from,
        address to,
        uint256 amount
    ) external returns (bool);

    function balanceOf(address account) external view returns (uint256);
}

/// @title MockFraxOFT
/// @notice Mock OFT messenger exposing a configurable underlying token()
/// @dev Simulates a Tempo OFT adapter for the non-forkable Tempo suite only. The
///      oft.token() != sendingAssetId branch is exercised against a real hop-approved OFT
///      (sfrxUSD) on the Arbitrum fork, not with this mock.
contract MockFraxOFT is IFraxOFT {
    address public token;

    constructor(address _token) {
        token = _token;
    }
}

/// @title MockTipFeeManager
/// @notice Mock of the Tempo TIP20 fee manager precompile
contract MockTipFeeManager is ITipFeeManager {
    mapping(address => address) internal _userTokens;

    function setUserToken(address user, address token) external {
        _userTokens[user] = token;
    }

    function userTokens(address user) external view returns (address) {
        return _userTokens[user];
    }
}

/// @title MockFraxHopV2Tempo
/// @notice Local mock of Frax HopV2 exercising the FraxFacet Tempo (ERC20 fee) branch.
/// @dev Rationale (rule 400): the real Tempo chain relies on precompile-backed TIP20
///      tokens and a LayerZero EndpointV2Alt whose logic is implemented at the node
///      level (codesize 1), so a Foundry fork cannot reproduce sendOFT / deal / the fee
///      pull on those addresses. This mock replicates the exact on-chain behaviour the
///      FraxFacet Tempo path depends on: dust flooring, a msg.value==0 requirement, and a
///      transferFrom pull of both the bridged token and the fee token from the caller (the
///      diamond). The facet supplies the fee-token amount via FraxData.nativeFee and does not
///      quote on-chain; quote/quoteStatic remain implemented for interface fidelity.
contract MockFraxHopV2Tempo is IFraxHopV2 {
    error NativeValueNotAllowed();
    error BridgedTokenPullFailed();
    error FeeTokenPullFailed();

    uint256 internal immutable DUST_RATE;

    address public feeToken;
    uint256 public feePull;

    uint256 public lastAmountPulled;

    constructor(uint256 _dustRate) {
        DUST_RATE = _dustRate;
    }

    /// @notice Mirrors HopV2.approvedOft, which allowlists routable OFTs.
    /// @dev Always true here: the facet's unapproved-OFT rejection is covered against the
    ///      real hop on the Arbitrum fork (FraxFacetTest), so this mock only needs to let
    ///      the Tempo fee-path tests through.
    function approvedOft(address) external pure returns (bool) {
        return true;
    }

    /// @notice Configures the fee token and the amount sendOFT pulls from the caller
    ///         (the diamond). Setting feePull below the facet's deposited nativeFee leaves
    ///         unused fee in the diamond so the facet's refund sweep can be exercised.
    function setFeeConfig(address _feeToken, uint256 _feePull) external {
        feeToken = _feeToken;
        feePull = _feePull;
    }

    function removeDust(
        address,
        uint256 amountLD
    ) external view returns (uint256) {
        return (amountLD / DUST_RATE) * DUST_RATE;
    }

    function quote(
        address,
        uint32,
        bytes32,
        uint256,
        uint128,
        bytes calldata
    ) external view returns (uint256) {
        return feePull;
    }

    function quoteStatic(
        address,
        uint32,
        bytes32,
        uint256,
        uint128,
        bytes calldata,
        address
    ) external view returns (uint256) {
        return feePull;
    }

    function sendOFT(
        address oft,
        uint32,
        bytes32,
        uint256 amountLD,
        uint128,
        bytes calldata
    ) external payable {
        // Tempo's EndpointV2Alt rejects native msg.value
        if (msg.value != 0) revert NativeValueNotAllowed();

        address token = IFraxOFT(oft).token();
        if (
            !IERC20Like(token).transferFrom(
                msg.sender,
                address(this),
                amountLD
            )
        ) revert BridgedTokenPullFailed();
        lastAmountPulled = amountLD;

        if (feePull != 0) {
            if (
                !IERC20Like(feeToken).transferFrom(
                    msg.sender,
                    address(this),
                    feePull
                )
            ) revert FeeTokenPullFailed();
        }
    }
}
