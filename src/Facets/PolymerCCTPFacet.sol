// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {PolymerCCTPData} from "../Interfaces/IPolymerCCTP.sol";
import {ILiFi} from "../Interfaces/ILiFi.sol";
import {ITokenMessenger} from "../Interfaces/ITokenMessenger.sol";
import {IPolymerCCTPFacet, PolymerCCTPData} from "../Interfaces/IPolymerCCTP.sol";
import {LiFiData} from "../Helpers/LiFiData.sol";
import {LibAsset, IERC20} from "../Libraries/LibAsset.sol";
import {LibSwap} from "../Libraries/LibSwap.sol";
import {SwapperV2} from "../Helpers/SwapperV2.sol";
import {Validatable} from "../Helpers/Validatable.sol";

/// @title PolymerCCTPFacet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging USDC through Polymer CCTP
/// @custom:version 1.0.0
contract PolymerCCTPFacet is IPolymerCCTPFacet, ILiFi, ReentrancyGuard, SwapperV2, Validatable, LiFiData {
    ITokenMessenger public immutable tokenMessenger;
    address public immutable usdc;
    address payable public immutable polymerFeeReceiver;

    constructor(address _tokenMessenger, address _usdc, address _polymerFeeReceiver) {
        // TODO: Do we want to have fee collector here?

        if (_tokenMessenger == address(0) || _usdc == address(0) || _polymerFeeReceiver == address(0)) {
            revert InvalidAddress();
        }

        tokenMessenger = ITokenMessenger(_tokenMessenger);
        usdc = _usdc;
        polymerFeeReceiver = payable(_polymerFeeReceiver);
    }

    /// @notice Bridges USDC via PolymerCCTP
    /// @param _bridgeData The core bridge data
    /// @param _polymerData Data specific to PolymerCCTP
    /// @notice Requires caller to approve the LifiDiamondProxy of the bridge amount + polymerFee
    function startBridgeTokensViaPolymerCCTP(ILiFi.BridgeData memory _bridgeData, PolymerCCTPData calldata _polymerData)
        external
        payable
        nonReentrant
        refundExcessNative(payable(msg.sender))
        validateBridgeData(_bridgeData)
        onlyAllowSourceToken(_bridgeData, usdc)
        doesNotContainSourceSwaps(_bridgeData)
        doesNotContainDestinationCalls(_bridgeData)
    {
        // TODO - is it worth validating the integrator and bridge from the bridgeData here?
        if(_bridgeData.minAmount == 0){
            revert InvalidBridgeAmount();
        }
        if (_bridgeData.receiver == address(0)){
            revert InvalidBridgeReceiver();

        }
        if(_bridgeData.sendingAssetId != usdc){
            revert InvalidSendingAsset(_bridgeData.sendingAssetId , usdc);
        }

        // TODO: Do we need this check if it's always going to be usdc?
        LibAsset.depositAsset(_bridgeData.sendingAssetId, _bridgeData.minAmount );
        LibAsset.transferFromERC20( usdc,  msg.sender, polymerFeeReceiver, _polymerData.polymerTokenFee );


        // TODO we don't need to use safe approve here?
        IERC20(usdc).approve(address(tokenMessenger), _bridgeData.minAmount);

        // Need tocheck: can we just use destinationChainID as the normal chain id? and can we just mpass in min Amount as the amountT?
        tokenMessenger.depositForBurn(
            _bridgeData.minAmount,
            uint32(_bridgeData.destinationChainId),
            _bridgeData.receiver == NON_EVM_ADDRESS
                ? _polymerData.nonEvmAddress
                : bytes32(uint256(uint160(_bridgeData.receiver))),
            usdc,
            bytes32(0), // Unrestricted caller
            _polymerData.maxCCTPFee, // maxFee - 0 means no fee limit
            _polymerData.minFinalityThreshold // minFinalityThreshold - use default
        );

        emit PolymerCCTPFeeSent( _bridgeData.minAmount, _polymerData.polymerTokenFee, _polymerData.minFinalityThreshold);

        // Emit Li.Fi standard event
        // TODO: Check - do we need to emit this event? 
        emit LiFiTransferStarted(
            BridgeData(
                _bridgeData.transactionId,
                _bridgeData.bridge,
                _bridgeData.integrator,
                _bridgeData.referrer,
                _bridgeData.sendingAssetId,
                _bridgeData.receiver,
                _bridgeData.minAmount,
                _bridgeData.destinationChainId,
                _bridgeData.hasSourceSwaps,
                _bridgeData.hasDestinationCall
            )
        );
    }
}
