pragma solidity 0.8.17;

import { IHopBridge } from "../Interfaces/IHopBridge.sol";
import { ILiFi } from "../Interfaces/ILiFi.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title Hop Facet (Optimized for Rollups)
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through Hop
contract HopFacetPacked is ILiFi {

    /// External Methods ///

    /// @notice Bridges Native tokens via Hop Protocol from L2
    /// No params, all data will be extracted from manually encoded callData
    function startBridgeTokensViaHopL2NativePacked(
    ) external payable {
        require(msg.data.length >= 120, "CallData length smaler than required.");

        _startBridgeTokensViaHopL2Native({
            // first 4 bytes are function signature
            transactionId: bytes32(bytes8(msg.data[4:12])),
            integrator: string(msg.data[12:28]), // bytes16 > string
            receiver: address(bytes20(msg.data[28:48])),
            destinationChainId: uint256(uint32(bytes4(msg.data[48:52]))),
            bonderFee: uint256(uint128(bytes16(msg.data[52:68]))),
            amountOutMin: uint256(uint128(bytes16(msg.data[68:84]))),
            destinationAmountOutMin: uint256(uint128(bytes16(msg.data[84:100]))),
            hopBridge: address(bytes20(msg.data[100:120]))
            // => total calldata length required: 120
        });
    }

    /// @notice Bridges Native tokens via Hop Protocol from L2
    /// @param transactionId Custom transaction ID for tracking
    /// @param integrator LI.FI partner name
    /// @param receiver Receiving wallet address
    /// @param destinationChainId Receiving chain
    /// @param bonderFee Fees payed to hop bonder
    /// @param amountOutMin Source swap minimal accepted amount
    /// @param destinationAmountOutMin Destination swap minimal accepted amount
    /// @param hopBridge Address of the Hop L2_AmmWrapper
    function startBridgeTokensViaHopL2NativeMin(
        bytes32 transactionId,
        string calldata integrator,
        address receiver,
        uint256 destinationChainId,
        uint256 bonderFee,
        uint256 amountOutMin,
        uint256 destinationAmountOutMin,
        address hopBridge
    ) external payable {
        _startBridgeTokensViaHopL2Native(
            transactionId,
            integrator,
            receiver,
            destinationChainId,
            bonderFee,
            amountOutMin,
            destinationAmountOutMin,
            hopBridge
        );
    }

    /// @notice Bridges Native tokens via Hop Protocol from L2
    /// @param transactionId Custom transaction ID for tracking
    /// @param integrator LI.FI partner name
    /// @param receiver Receiving wallet address
    /// @param destinationChainId Receiving chain
    /// @param bonderFee Fees payed to hop bonder
    /// @param amountOutMin Source swap minimal accepted amount
    /// @param destinationAmountOutMin Destination swap minimal accepted amount
    /// @param hopBridge Address of the Hop L2_AmmWrapper
    function encoder_startBridgeTokensViaHopL2NativePacked(
        bytes32 transactionId,
        string calldata integrator,
        address receiver,
        uint256 destinationChainId,
        uint256 bonderFee,
        uint256 amountOutMin,
        uint256 destinationAmountOutMin,
        address hopBridge
    ) external pure returns (bytes memory) {
        require(destinationChainId <= type(uint32).max, "destinationChainId value passed too big to fit in uint32");
        require(bonderFee <= type(uint128).max, "bonderFee value passed too big to fit in uint128");
        require(amountOutMin <= type(uint128).max, "amountOutMin value passed too big to fit in uint128");
        require(destinationAmountOutMin <= type(uint128).max, "destinationAmountOutMin value passed too big to fit in uint128");

        return bytes.concat(
            HopFacetPacked.startBridgeTokensViaHopL2NativePacked.selector,
            bytes8(transactionId),
            bytes16(bytes(integrator)),
            bytes20(receiver),
            bytes4(uint32(destinationChainId)),
            bytes16(uint128(bonderFee)),
            bytes16(uint128(amountOutMin)),
            bytes16(uint128(destinationAmountOutMin)),
            bytes20(hopBridge)
        );
    }

    /// @notice Bridges ERC20 tokens via Hop Protocol from L2
    /// No params, all data will be extracted from manually encoded callData
    function startBridgeTokensViaHopL2ERC20Packed(
    ) external {
        require(msg.data.length >= 156, "CallData length smaler than required.");

        _startBridgeTokensViaHopL2ERC20({
            // first 4 bytes are function signature
            transactionId: bytes32(bytes8(msg.data[4:12])),
            integrator: string(msg.data[12:28]), // bytes16 > string
            receiver: address(bytes20(msg.data[28:48])),
            destinationChainId: uint256(uint32(bytes4(msg.data[48:52]))),
            sendingAssetId:  address(bytes20(msg.data[52:72])),
            amount: uint256(uint128(bytes16(msg.data[72:88]))),
            bonderFee: uint256(uint128(bytes16(msg.data[88:104]))),
            amountOutMin: uint256(uint128(bytes16(msg.data[104:120]))),
            destinationAmountOutMin: uint256(uint128(bytes16(msg.data[120:136]))),
            hopBridge: address(bytes20(msg.data[136:156]))
            // => total calldata length required: 156
        });
    }

    /// @notice Bridges ERC20 tokens via Hop Protocol from L2
    /// @param transactionId Custom transaction ID for tracking
    /// @param integrator LI.FI partner name
    /// @param receiver Receiving wallet address
    /// @param destinationChainId Receiving chain
    /// @param sendingAssetId Address of the source asset to bridge
    /// @param amount Amount of the source asset to bridge
    /// @param bonderFee Fees payed to hop bonder
    /// @param amountOutMin Source swap minimal accepted amount
    /// @param destinationAmountOutMin Destination swap minimal accepted amount
    /// @param hopBridge Address of the Hop L2_AmmWrapper
    function startBridgeTokensViaHopL2ERC20Min(
        bytes32 transactionId,
        string calldata integrator,
        address receiver,
        uint256 destinationChainId,
        address sendingAssetId,
        uint256 amount,
        uint256 bonderFee,
        uint256 amountOutMin,
        uint256 destinationAmountOutMin,
        address hopBridge
    ) external {
        _startBridgeTokensViaHopL2ERC20(
            transactionId,
            integrator,
            receiver,
            destinationChainId,
            sendingAssetId,
            amount,
            bonderFee,
            amountOutMin,
            destinationAmountOutMin,
            hopBridge
        );
    }

    /// @notice Bridges ERC20 tokens via Hop Protocol from L2
    /// @param transactionId Custom transaction ID for tracking
    /// @param integrator LI.FI partner name
    /// @param receiver Receiving wallet address
    /// @param destinationChainId Receiving chain
    /// @param sendingAssetId Address of the source asset to bridge
    /// @param amount Amount of the source asset to bridge
    /// @param bonderFee Fees payed to hop bonder
    /// @param amountOutMin Source swap minimal accepted amount
    /// @param destinationAmountOutMin Destination swap minimal accepted amount
    /// @param hopBridge Address of the Hop L2_AmmWrapper
    function encoder_startBridgeTokensViaHopL2ERC20Packed(
        bytes32 transactionId,
        string calldata integrator,
        address receiver,
        uint256 destinationChainId,
        address sendingAssetId,
        uint256 amount,
        uint256 bonderFee,
        uint256 amountOutMin,
        uint256 destinationAmountOutMin,
        address hopBridge
    ) external pure returns (bytes memory) {
        require(destinationChainId <= type(uint32).max, "destinationChainId value passed too big to fit in uint32");
        require(amount <= type(uint128).max, "amount value passed too big to fit in uint128");
        require(bonderFee <= type(uint128).max, "bonderFee value passed too big to fit in uint128");
        require(amountOutMin <= type(uint128).max, "amountOutMin value passed too big to fit in uint128");
        require(destinationAmountOutMin <= type(uint128).max, "destinationAmountOutMin value passed too big to fit in uint128");

        return bytes.concat(
            HopFacetPacked.startBridgeTokensViaHopL2ERC20Packed.selector,
            bytes8(transactionId),
            bytes16(bytes(integrator)),
            bytes20(receiver),
            bytes4(uint32(destinationChainId)),
            bytes20(sendingAssetId),
            bytes16(uint128(amount)),
            bytes16(uint128(bonderFee)),
            bytes16(uint128(amountOutMin)),
            bytes16(uint128(destinationAmountOutMin)),
            bytes20(hopBridge)
        );
    }

    /// @notice Bridges Native tokens via Hop Protocol from L1
    /// @param transactionId Custom transaction ID for tracking
    /// @param integrator LI.FI partner name
    /// @param receiver Receiving wallet address
    /// @param destinationChainId Receiving chain
    /// @param destinationAmountOutMin Destination swap minimal accepted amount
    /// @param hopBridge Address of the Hop Bridge
    function startBridgeTokensViaHopL1NativeMin(
        bytes32 transactionId,
        string memory integrator,
        address receiver,
        uint256 destinationChainId,
        uint256 destinationAmountOutMin,
        address hopBridge
    ) external payable {
        _startBridgeTokensViaHopL1Native(
            transactionId,
            integrator,
            receiver,
            destinationChainId,
            destinationAmountOutMin,
            hopBridge
        );
    }

    /// @notice Bridges ERC20 tokens via Hop Protocol from L1
    /// @param transactionId Custom transaction ID for tracking
    /// @param integrator LI.FI partner name
    /// @param receiver Receiving wallet address
    /// @param destinationChainId Receiving chain
    /// @param sendingAssetId Address of the source asset to bridge
    /// @param amount Amount of the source asset to bridge
    /// @param destinationAmountOutMin Destination swap minimal accepted amount
    /// @param hopBridge Address of the Hop Bridge
    function startBridgeTokensViaHopL1ERC20Min(
        bytes32 transactionId,
        string calldata integrator,
        address receiver,
        uint256 destinationChainId,
        address sendingAssetId,
        uint256 amount,
        uint256 destinationAmountOutMin,
        address hopBridge
    ) external {
        _startBridgeTokensViaHopL1ERC20(
            transactionId,
            integrator,
            receiver,
            destinationChainId,
            sendingAssetId,
            amount,
            destinationAmountOutMin,
            hopBridge
        );
    }

    /// Internal Methods ///

    function _startBridgeTokensViaHopL2Native(
        bytes32 transactionId,
        string memory integrator,
        address receiver,
        uint256 destinationChainId,
        uint256 bonderFee,
        uint256 amountOutMin,
        uint256 destinationAmountOutMin,
        address hopBridge
    ) private {
        // Bridge assets
        uint256 deadline = block.timestamp + 60 * 20;
        IHopBridge(hopBridge).swapAndSend{ value: msg.value }(
            destinationChainId,
            receiver,
            msg.value,
            bonderFee,
            amountOutMin,
            deadline,
            destinationAmountOutMin,
            deadline
        );

        emit LiFiTransferStarted(BridgeData({
            transactionId: transactionId,
            bridge: "hop",
            integrator: integrator,
            referrer: address(0),
            sendingAssetId: address(0),
            receiver: receiver,
            minAmount: msg.value,
            destinationChainId: destinationChainId,
            hasSourceSwaps: false,
            hasDestinationCall: false
        }));
    }

    function _startBridgeTokensViaHopL2ERC20(
        bytes32 transactionId,
        string memory integrator,
        address receiver,
        uint256 destinationChainId,
        address sendingAssetId,
        uint256 amount,
        uint256 bonderFee,
        uint256 amountOutMin,
        uint256 destinationAmountOutMin,
        address hopBridge
    ) private {
        // Deposit assets
        SafeERC20.safeTransferFrom(IERC20(sendingAssetId), msg.sender, address(this), amount);

        // Bridge assets
        uint256 deadline = block.timestamp + 60 * 20;
        IHopBridge(hopBridge).swapAndSend(
            destinationChainId,
            receiver,
            amount,
            bonderFee,
            amountOutMin,
            deadline,
            destinationAmountOutMin,
            deadline
        );

        emit LiFiTransferStarted(BridgeData({
            transactionId: transactionId,
            bridge: "hop",
            integrator: integrator,
            referrer: address(0),
            sendingAssetId: sendingAssetId,
            receiver: receiver,
            minAmount: amount,
            destinationChainId: destinationChainId,
            hasSourceSwaps: false,
            hasDestinationCall: false
        }));
    }

    function _startBridgeTokensViaHopL1Native(
        bytes32 transactionId,
        string memory integrator,
        address receiver,
        uint256 destinationChainId,
        uint256 destinationAmountOutMin,
        address hopBridge
    ) private {
        // Bridge assets
        uint256 deadline = block.timestamp + 60 * 20;
        IHopBridge(hopBridge).sendToL2{ value: msg.value }(
            destinationChainId,
            receiver,
            msg.value,
            destinationAmountOutMin,
            deadline,
            address(0),
            0
        );

        emit LiFiTransferStarted(BridgeData({
            transactionId: transactionId,
            bridge: "hop",
            integrator: integrator,
            referrer: address(0),
            sendingAssetId: address(0),
            receiver: receiver,
            minAmount: msg.value,
            destinationChainId: destinationChainId,
            hasSourceSwaps: false,
            hasDestinationCall: false
        }));
    }

    function _startBridgeTokensViaHopL1ERC20(
        bytes32 transactionId,
        string memory integrator,
        address receiver,
        uint256 destinationChainId,
        address sendingAssetId,
        uint256 amount,
        uint256 destinationAmountOutMin,
        address hopBridge
    ) private {
        // Deposit assets
        SafeERC20.safeTransferFrom(IERC20(sendingAssetId), msg.sender, address(this), amount);

        // Bridge assets
        uint256 deadline = block.timestamp + 60 * 20;
        IHopBridge(hopBridge).sendToL2(
            destinationChainId,
            receiver,
            amount,
            destinationAmountOutMin,
            deadline,
            address(0),
            0
        );

        emit LiFiTransferStarted(BridgeData({
            transactionId: transactionId,
            bridge: "hop",
            integrator: integrator,
            referrer: address(0),
            sendingAssetId: sendingAssetId,
            receiver: receiver,
            minAmount: amount,
            destinationChainId: destinationChainId,
            hasSourceSwaps: false,
            hasDestinationCall: false
        }));
    }

}
