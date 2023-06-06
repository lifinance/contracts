pragma solidity 0.8.17;

import { IHopBridge, IL2AmmWrapper, ISwap } from "../Interfaces/IHopBridge.sol";
import { ILiFi } from "../Interfaces/ILiFi.sol";
import { ERC20 } from "solmate/utils/SafeTransferLib.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { TransferrableOwnership } from "../Helpers/TransferrableOwnership.sol";
import { HopFacetOptimized } from "lifi/Facets/HopFacetOptimized.sol";
import { WETH } from "solmate/tokens/WETH.sol";

/// @title Hop Facet (Optimized for Rollups)
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through Hop
/// @custom:version 1.0.5
contract HopFacetPacked is ILiFi, TransferrableOwnership {
    /// Storage ///

    address public immutable nativeBridge;
    address public immutable nativeL2CanonicalToken;
    address public immutable nativeHToken;
    address public immutable nativeExchangeAddress;

    /// Errors ///

    error Invalid();

    /// Events ///

    event LiFiHopTransfer(bytes8 _transactionId);

    /// Constructor ///

    /// @notice Initialize the contract.
    /// @param _owner The contract owner to approve tokens.
    /// @param _wrapper The address of Hop L2_AmmWrapper for native asset.
    constructor(
        address _owner,
        address _wrapper
    ) TransferrableOwnership(_owner) {
        bool wrapperIsSet = _wrapper != address(0);

        if (block.chainid == 1 && wrapperIsSet) {
            revert Invalid();
        }

        nativeL2CanonicalToken = wrapperIsSet
            ? IL2AmmWrapper(_wrapper).l2CanonicalToken()
            : address(0);
        nativeHToken = wrapperIsSet
            ? IL2AmmWrapper(_wrapper).hToken()
            : address(0);
        nativeExchangeAddress = wrapperIsSet
            ? IL2AmmWrapper(_wrapper).exchangeAddress()
            : address(0);
        nativeBridge = wrapperIsSet
            ? IL2AmmWrapper(_wrapper).bridge()
            : address(0);
    }

    /// External Methods ///

    /// @dev Only meant to be called outside of the context of the diamond
    /// @notice Sets approval for the Hop Bridge to spend the specified token
    /// @param bridges The Hop Bridges to approve
    /// @param tokensToApprove The tokens to approve to approve to the Hop Bridges
    function setApprovalForHopBridges(
        address[] calldata bridges,
        address[] calldata tokensToApprove
    ) external onlyOwner {
        uint256 numBridges = bridges.length;

        for (uint256 i; i < numBridges; i++) {
            // Give Hop approval to bridge tokens
            LibAsset.maxApproveERC20(
                IERC20(tokensToApprove[i]),
                address(bridges[i]),
                type(uint256).max
            );
        }
    }

    /// @notice Bridges Native tokens via Hop Protocol from L2
    /// No params, all data will be extracted from manually encoded callData
    function startBridgeTokensViaHopL2NativePacked() external payable {
        // first 4 bytes are function signature
        // transactionId: bytes8(msg.data[4:12]),
        // receiver: address(bytes20(msg.data[12:32])),
        // destinationChainId: uint256(uint32(bytes4(msg.data[32:36]))),
        // bonderFee: uint256(uint128(bytes16(msg.data[36:52]))),
        // amountOutMin: uint256(uint128(bytes16(msg.data[52:68])))
        // => total calldata length required: 68

        uint256 destinationChainId = uint256(uint32(bytes4(msg.data[32:36])));
        uint256 amountOutMin = uint256(uint128(bytes16(msg.data[52:68])));
        bool toL1 = destinationChainId == 1;

        // Wrap ETH
        WETH(payable(nativeL2CanonicalToken)).deposit{ value: msg.value }();

        // Exchange WETH for hToken
        uint256 swapAmount = ISwap(nativeExchangeAddress).swap(
            0,
            1,
            msg.value,
            amountOutMin,
            block.timestamp
        );

        // Bridge assets
        // solhint-disable-next-line check-send-result
        IHopBridge(nativeBridge).send(
            destinationChainId,
            address(bytes20(msg.data[12:32])), // receiver
            swapAmount,
            uint256(uint128(bytes16(msg.data[36:52]))), // bonderFee
            toL1 ? 0 : amountOutMin,
            toL1 ? 0 : block.timestamp + 7 * 24 * 60 * 60
        );

        emit LiFiHopTransfer(
            bytes8(msg.data[4:12]) // transactionId
        );
    }

    /// @notice Bridges Native tokens via Hop Protocol from L2
    /// @param transactionId Custom transaction ID for tracking
    /// @param receiver Receiving wallet address
    /// @param destinationChainId Receiving chain
    /// @param bonderFee Fees payed to hop bonder
    /// @param amountOutMin Source swap minimal accepted amount
    /// @param destinationAmountOutMin Destination swap minimal accepted amount
    /// @param destinationDeadline Destination swap maximal time
    /// @param hopBridge Address of the Hop L2_AmmWrapper
    function startBridgeTokensViaHopL2NativeMin(
        bytes8 transactionId,
        address receiver,
        uint256 destinationChainId,
        uint256 bonderFee,
        uint256 amountOutMin,
        uint256 destinationAmountOutMin,
        uint256 destinationDeadline,
        address hopBridge
    ) external payable {
        // Bridge assets
        IHopBridge(hopBridge).swapAndSend{ value: msg.value }(
            destinationChainId,
            receiver,
            msg.value,
            bonderFee,
            amountOutMin,
            block.timestamp,
            destinationAmountOutMin,
            destinationDeadline
        );

        emit LiFiHopTransfer(transactionId);
    }

    /// @notice Bridges Native tokens via Hop Protocol from L2
    /// @param transactionId Custom transaction ID for tracking
    /// @param receiver Receiving wallet address
    /// @param destinationChainId Receiving chain
    /// @param bonderFee Fees payed to hop bonder
    /// @param amountOutMin Source swap minimal accepted amount
    function encode_startBridgeTokensViaHopL2NativePacked(
        bytes8 transactionId,
        address receiver,
        uint256 destinationChainId,
        uint256 bonderFee,
        uint256 amountOutMin
    ) external pure returns (bytes memory) {
        require(
            destinationChainId <= type(uint32).max,
            "destinationChainId value passed too big to fit in uint32"
        );
        require(
            bonderFee <= type(uint128).max,
            "bonderFee value passed too big to fit in uint128"
        );
        require(
            amountOutMin <= type(uint128).max,
            "amountOutMin value passed too big to fit in uint128"
        );

        return
            bytes.concat(
                HopFacetPacked.startBridgeTokensViaHopL2NativePacked.selector,
                bytes8(transactionId),
                bytes20(receiver),
                bytes4(uint32(destinationChainId)),
                bytes16(uint128(bonderFee)),
                bytes16(uint128(amountOutMin))
            );
    }

    /// @notice Decodes calldata for startBridgeTokensViaHopL2NativePacked
    /// @param _data the calldata to decode
    function decode_startBridgeTokensViaHopL2NativePacked(
        bytes calldata _data
    )
        external
        pure
        returns (BridgeData memory, HopFacetOptimized.HopData memory)
    {
        require(
            _data.length >= 68,
            "data passed in is not the correct length"
        );

        BridgeData memory bridgeData;
        HopFacetOptimized.HopData memory hopData;

        bridgeData.transactionId = bytes32(bytes8(_data[4:12]));
        bridgeData.receiver = address(bytes20(_data[12:32]));
        bridgeData.destinationChainId = uint256(uint32(bytes4(_data[32:36])));
        hopData.bonderFee = uint256(uint128(bytes16(_data[36:52])));
        hopData.amountOutMin = uint256(uint128(bytes16(_data[52:68])));

        return (bridgeData, hopData);
    }

    /// @notice Bridges ERC20 tokens via Hop Protocol from L2
    /// No params, all data will be extracted from manually encoded callData
    function startBridgeTokensViaHopL2ERC20Packed() external {
        // first 4 bytes are function signature
        // transactionId: bytes8(msg.data[4:12]),
        // receiver: address(bytes20(msg.data[12:32])),
        // destinationChainId: uint256(uint32(bytes4(msg.data[32:36]))),
        // sendingAssetId: address(bytes20(msg.data[36:56])),
        // amount: uint256(uint128(bytes16(msg.data[56:72]))),
        // bonderFee: uint256(uint128(bytes16(msg.data[72:88]))),
        // amountOutMin: uint256(uint128(bytes16(msg.data[88:104]))),
        // destinationAmountOutMin: uint256(uint128(bytes16(msg.data[104:120]))),
        // destinationDeadline: uint256(uint32(bytes4(msg.data[120:124]))),
        // wrapper: address(bytes20(msg.data[124:144]))
        // exchangeAddress: address(bytes20(msg.data[144:164]))
        // bridge: address(bytes20(msg.data[164:184]))
        // => total calldata length required: 184

        uint256 destinationChainId = uint256(uint32(bytes4(msg.data[32:36])));
        uint256 amount = uint256(uint128(bytes16(msg.data[56:72])));
        uint256 amountOutMin = uint256(uint128(bytes16(msg.data[88:104])));
        bool toL1 = destinationChainId == 1;

        // Deposit assets
        ERC20(address(bytes20(msg.data[36:56]))).transferFrom(
            msg.sender,
            address(this),
            amount
        );

        // Exchange sending asset to hToken
        uint256 swapAmount = ISwap(address(bytes20(msg.data[144:164]))).swap(
            0,
            1,
            amount,
            amountOutMin,
            block.timestamp
        );

        // Bridge assets
        // solhint-disable-next-line check-send-result
        IHopBridge(address(bytes20(msg.data[164:184]))).send(
            destinationChainId,
            address(bytes20(msg.data[12:32])),
            swapAmount,
            uint256(uint128(bytes16(msg.data[72:88]))),
            toL1 ? 0 : uint256(uint128(bytes16(msg.data[104:120]))),
            toL1 ? 0 : uint256(uint32(bytes4(msg.data[120:124])))
        );

        emit LiFiHopTransfer(bytes8(msg.data[4:12]));
    }

    /// @notice Bridges ERC20 tokens via Hop Protocol from L2
    /// @param transactionId Custom transaction ID for tracking
    /// @param receiver Receiving wallet address
    /// @param destinationChainId Receiving chain
    /// @param sendingAssetId Address of the source asset to bridge
    /// @param minAmount Amount of the source asset to bridge
    /// @param bonderFee Fees payed to hop bonder
    /// @param amountOutMin Source swap minimal accepted amount
    /// @param destinationAmountOutMin Destination swap minimal accepted amount
    /// @param destinationDeadline Destination swap maximal time
    /// @param hopBridge Address of the Hop L2_AmmWrapper
    function startBridgeTokensViaHopL2ERC20Min(
        bytes8 transactionId,
        address receiver,
        uint256 destinationChainId,
        address sendingAssetId,
        uint256 minAmount,
        uint256 bonderFee,
        uint256 amountOutMin,
        uint256 destinationAmountOutMin,
        uint256 destinationDeadline,
        address hopBridge
    ) external {
        // Deposit assets
        ERC20(sendingAssetId).transferFrom(
            msg.sender,
            address(this),
            minAmount
        );

        // Bridge assets
        IHopBridge(hopBridge).swapAndSend(
            destinationChainId,
            receiver,
            minAmount,
            bonderFee,
            amountOutMin,
            block.timestamp,
            destinationAmountOutMin,
            destinationDeadline
        );

        emit LiFiHopTransfer(transactionId);
    }

    /// @notice Bridges ERC20 tokens via Hop Protocol from L2
    /// @param transactionId Custom transaction ID for tracking
    /// @param receiver Receiving wallet address
    /// @param destinationChainId Receiving chain
    /// @param sendingAssetId Address of the source asset to bridge
    /// @param minAmount Amount of the source asset to bridge
    /// @param bonderFee Fees payed to hop bonder
    /// @param amountOutMin Source swap minimal accepted amount
    /// @param destinationAmountOutMin Destination swap minimal accepted amount
    /// @param destinationDeadline Destination swap maximal time
    /// @param wrapper Address of the Hop L2_AmmWrapper
    function encode_startBridgeTokensViaHopL2ERC20Packed(
        bytes32 transactionId,
        address receiver,
        uint256 destinationChainId,
        address sendingAssetId,
        uint256 minAmount,
        uint256 bonderFee,
        uint256 amountOutMin,
        uint256 destinationAmountOutMin,
        uint256 destinationDeadline,
        address wrapper
    ) external view returns (bytes memory) {
        require(
            destinationChainId <= type(uint32).max,
            "destinationChainId value passed too big to fit in uint32"
        );
        require(
            minAmount <= type(uint128).max,
            "amount value passed too big to fit in uint128"
        );
        require(
            bonderFee <= type(uint128).max,
            "bonderFee value passed too big to fit in uint128"
        );
        require(
            amountOutMin <= type(uint128).max,
            "amountOutMin value passed too big to fit in uint128"
        );
        require(
            destinationAmountOutMin <= type(uint128).max,
            "destinationAmountOutMin value passed too big to fit in uint128"
        );
        require(
            destinationDeadline <= type(uint32).max,
            "destinationDeadline value passed too big to fit in uint32"
        );

        return
            bytes.concat(
                HopFacetPacked.startBridgeTokensViaHopL2ERC20Packed.selector,
                bytes8(transactionId),
                bytes20(receiver),
                bytes4(uint32(destinationChainId)),
                bytes20(sendingAssetId),
                bytes16(uint128(minAmount)),
                bytes16(uint128(bonderFee)),
                bytes16(uint128(amountOutMin)),
                bytes16(uint128(destinationAmountOutMin)),
                bytes4(uint32(destinationDeadline)),
                bytes20(wrapper),
                bytes20(IL2AmmWrapper(wrapper).exchangeAddress()),
                bytes20(IL2AmmWrapper(wrapper).bridge())
            );
    }

    /// @notice Decodes calldata for startBridgeTokensViaHopL2ERC20Packed
    /// @param _data the calldata to decode
    function decode_startBridgeTokensViaHopL2ERC20Packed(
        bytes calldata _data
    )
        external
        pure
        returns (BridgeData memory, HopFacetOptimized.HopData memory)
    {
        require(
            _data.length >= 144,
            "data passed in is not the correct length"
        );

        BridgeData memory bridgeData;
        HopFacetOptimized.HopData memory hopData;

        bridgeData.transactionId = bytes32(bytes8(_data[4:12]));
        bridgeData.receiver = address(bytes20(_data[12:32]));
        bridgeData.destinationChainId = uint256(uint32(bytes4(_data[32:36])));
        bridgeData.sendingAssetId = address(bytes20(_data[36:56]));
        bridgeData.minAmount = uint256(uint128(bytes16(_data[56:72])));
        hopData.bonderFee = uint256(uint128(bytes16(_data[72:88])));
        hopData.amountOutMin = uint256(uint128(bytes16(_data[88:104])));
        hopData.destinationAmountOutMin = uint256(
            uint128(bytes16(_data[104:120]))
        );
        hopData.destinationDeadline = uint256(uint32(bytes4(_data[120:124])));
        hopData.hopBridge = IHopBridge(address(bytes20(_data[124:144])));

        return (bridgeData, hopData);
    }

    /// @notice Bridges Native tokens via Hop Protocol from L1
    /// No params, all data will be extracted from manually encoded callData
    function startBridgeTokensViaHopL1NativePacked() external payable {
        // first 4 bytes are function signature
        // transactionId: bytes8(msg.data[4:12]),
        // receiver: address(bytes20(msg.data[12:32])),
        // destinationChainId: uint256(uint32(bytes4(msg.data[32:36]))),
        // destinationAmountOutMin: uint256(uint128(bytes16(msg.data[36:52]))),
        // relayer: address(bytes20(msg.data[52:72])),
        // relayerFee: uint256(uint128(bytes16(msg.data[72:88]))),
        // hopBridge: address(bytes20(msg.data[88:108]))
        // => total calldata length required: 108

        // Bridge assets
        IHopBridge(address(bytes20(msg.data[88:108]))).sendToL2{
            value: msg.value
        }(
            uint256(uint32(bytes4(msg.data[32:36]))),
            address(bytes20(msg.data[12:32])),
            msg.value,
            uint256(uint128(bytes16(msg.data[36:52]))),
            block.timestamp + 7 * 24 * 60 * 60,
            address(bytes20(msg.data[52:72])),
            uint256(uint128(bytes16(msg.data[72:88])))
        );

        emit LiFiHopTransfer(bytes8(msg.data[4:12]));
    }

    /// @notice Bridges Native tokens via Hop Protocol from L1
    /// @param transactionId Custom transaction ID for tracking
    /// @param receiver Receiving wallet address
    /// @param destinationChainId Receiving chain
    /// @param destinationAmountOutMin Destination swap minimal accepted amount
    /// @param relayer needed for gas spikes
    /// @param relayerFee needed for gas spikes
    /// @param hopBridge Address of the Hop Bridge
    function startBridgeTokensViaHopL1NativeMin(
        bytes8 transactionId,
        address receiver,
        uint256 destinationChainId,
        uint256 destinationAmountOutMin,
        address relayer,
        uint256 relayerFee,
        address hopBridge
    ) external payable {
        // Bridge assets
        IHopBridge(hopBridge).sendToL2{ value: msg.value }(
            destinationChainId,
            receiver,
            msg.value,
            destinationAmountOutMin,
            block.timestamp + 7 * 24 * 60 * 60,
            relayer,
            relayerFee
        );

        emit LiFiHopTransfer(transactionId);
    }

    /// @notice Bridges Native tokens via Hop Protocol from L1
    /// @param transactionId Custom transaction ID for tracking
    /// @param receiver Receiving wallet address
    /// @param destinationChainId Receiving chain
    /// @param destinationAmountOutMin Destination swap minimal accepted amount
    /// @param relayer needed for gas spikes
    /// @param relayerFee needed for gas spikes
    /// @param hopBridge Address of the Hop Bridge
    function encode_startBridgeTokensViaHopL1NativePacked(
        bytes8 transactionId,
        address receiver,
        uint256 destinationChainId,
        uint256 destinationAmountOutMin,
        address relayer,
        uint256 relayerFee,
        address hopBridge
    ) external pure returns (bytes memory) {
        require(
            destinationChainId <= type(uint32).max,
            "destinationChainId value passed too big to fit in uint32"
        );
        require(
            destinationAmountOutMin <= type(uint128).max,
            "destinationAmountOutMin value passed too big to fit in uint128"
        );
        require(
            relayerFee <= type(uint128).max,
            "relayerFee value passed too big to fit in uint128"
        );

        return
            bytes.concat(
                HopFacetPacked.startBridgeTokensViaHopL1NativePacked.selector,
                bytes8(transactionId),
                bytes20(receiver),
                bytes4(uint32(destinationChainId)),
                bytes16(uint128(destinationAmountOutMin)),
                bytes20(relayer),
                bytes16(uint128(relayerFee)),
                bytes20(hopBridge)
            );
    }

    /// @notice Decodes calldata for startBridgeTokensViaHopL1NativePacked
    /// @param _data the calldata to decode
    function decode_startBridgeTokensViaHopL1NativePacked(
        bytes calldata _data
    )
        external
        pure
        returns (BridgeData memory, HopFacetOptimized.HopData memory)
    {
        require(
            _data.length >= 108,
            "data passed in is not the correct length"
        );

        BridgeData memory bridgeData;
        HopFacetOptimized.HopData memory hopData;

        bridgeData.transactionId = bytes32(bytes8(_data[4:12]));
        bridgeData.receiver = address(bytes20(_data[12:32]));
        bridgeData.destinationChainId = uint256(uint32(bytes4(_data[32:36])));
        hopData.destinationAmountOutMin = uint256(
            uint128(bytes16(_data[36:52]))
        );
        // relayer = address(bytes20(_data[52:72]));
        // relayerFee = uint256(uint128(bytes16(_data[72:88])));
        hopData.hopBridge = IHopBridge(address(bytes20(_data[88:108])));

        return (bridgeData, hopData);
    }

    /// @notice Bridges Native tokens via Hop Protocol from L1
    /// No params, all data will be extracted from manually encoded callData
    function startBridgeTokensViaHopL1ERC20Packed() external payable {
        // first 4 bytes are function signature
        // transactionId: bytes8(msg.data[4:12]),
        // receiver: address(bytes20(msg.data[12:32])),
        // destinationChainId: uint256(uint32(bytes4(msg.data[32:36]))),
        // sendingAssetId: address(bytes20(msg.data[36:56])),
        // amount: uint256(uint128(bytes16(msg.data[56:72]))),
        // destinationAmountOutMin: uint256(uint128(bytes16(msg.data[72:88]))),
        // relayer: address(bytes20(msg.data[88:108])),
        // relayerFee: uint256(uint128(bytes16(msg.data[108:124]))),
        // hopBridge: address(bytes20(msg.data[124:144]))
        // => total calldata length required: 144

        uint256 amount = uint256(uint128(bytes16(msg.data[56:72])));

        // Deposit assets
        ERC20(address(bytes20(msg.data[36:56]))).transferFrom(
            msg.sender,
            address(this),
            amount
        );

        // Bridge assets
        IHopBridge(address(bytes20(msg.data[124:144]))).sendToL2(
            uint256(uint32(bytes4(msg.data[32:36]))),
            address(bytes20(msg.data[12:32])),
            amount,
            uint256(uint128(bytes16(msg.data[72:88]))),
            block.timestamp + 7 * 24 * 60 * 60,
            address(bytes20(msg.data[88:108])),
            uint256(uint128(bytes16(msg.data[108:124])))
        );

        emit LiFiHopTransfer(bytes8(msg.data[4:12]));
    }

    /// @notice Bridges ERC20 tokens via Hop Protocol from L1
    /// @param transactionId Custom transaction ID for tracking
    /// @param receiver Receiving wallet address
    /// @param destinationChainId Receiving chain
    /// @param sendingAssetId Address of the source asset to bridge
    /// @param minAmount Amount of the source asset to bridge
    /// @param destinationAmountOutMin Destination swap minimal accepted amount
    /// @param relayer needed for gas spikes
    /// @param relayerFee needed for gas spikes
    /// @param hopBridge Address of the Hop Bridge
    function startBridgeTokensViaHopL1ERC20Min(
        bytes8 transactionId,
        address receiver,
        uint256 destinationChainId,
        address sendingAssetId,
        uint256 minAmount,
        uint256 destinationAmountOutMin,
        address relayer,
        uint256 relayerFee,
        address hopBridge
    ) external {
        // Deposit assets
        ERC20(sendingAssetId).transferFrom(
            msg.sender,
            address(this),
            minAmount
        );

        // Bridge assets
        IHopBridge(hopBridge).sendToL2(
            destinationChainId,
            receiver,
            minAmount,
            destinationAmountOutMin,
            block.timestamp + 7 * 24 * 60 * 60,
            relayer,
            relayerFee
        );

        emit LiFiHopTransfer(transactionId);
    }

    /// @notice Bridges ERC20 tokens via Hop Protocol from L1
    /// @param transactionId Custom transaction ID for tracking
    /// @param receiver Receiving wallet address
    /// @param destinationChainId Receiving chain
    /// @param sendingAssetId Address of the source asset to bridge
    /// @param minAmount Amount of the source asset to bridge
    /// @param destinationAmountOutMin Destination swap minimal accepted amount
    /// @param relayer needed for gas spikes
    /// @param relayerFee needed for gas spikes
    /// @param hopBridge Address of the Hop Bridge
    function encode_startBridgeTokensViaHopL1ERC20Packed(
        bytes8 transactionId,
        address receiver,
        uint256 destinationChainId,
        address sendingAssetId,
        uint256 minAmount,
        uint256 destinationAmountOutMin,
        address relayer,
        uint256 relayerFee,
        address hopBridge
    ) external pure returns (bytes memory) {
        require(
            destinationChainId <= type(uint32).max,
            "destinationChainId value passed too big to fit in uint32"
        );
        require(
            minAmount <= type(uint128).max,
            "amount value passed too big to fit in uint128"
        );
        require(
            destinationAmountOutMin <= type(uint128).max,
            "destinationAmountOutMin value passed too big to fit in uint128"
        );
        require(
            relayerFee <= type(uint128).max,
            "relayerFee value passed too big to fit in uint128"
        );

        return
            bytes.concat(
                HopFacetPacked.startBridgeTokensViaHopL1ERC20Packed.selector,
                bytes8(transactionId),
                bytes20(receiver),
                bytes4(uint32(destinationChainId)),
                bytes20(sendingAssetId),
                bytes16(uint128(minAmount)),
                bytes16(uint128(destinationAmountOutMin)),
                bytes20(relayer),
                bytes16(uint128(relayerFee)),
                bytes20(hopBridge)
            );
    }

    /// @notice Decodes calldata for startBridgeTokensViaHopL1ERC20Packed
    /// @param _data the calldata to decode
    function decode_startBridgeTokensViaHopL1ERC20Packed(
        bytes calldata _data
    )
        external
        pure
        returns (BridgeData memory, HopFacetOptimized.HopData memory)
    {
        require(
            _data.length >= 144,
            "data passed in is not the correct length"
        );

        BridgeData memory bridgeData;
        HopFacetOptimized.HopData memory hopData;

        bridgeData.transactionId = bytes32(bytes8(_data[4:12]));
        bridgeData.receiver = address(bytes20(_data[12:32]));
        bridgeData.destinationChainId = uint256(uint32(bytes4(_data[32:36])));
        bridgeData.sendingAssetId = address(bytes20(_data[36:56]));
        bridgeData.minAmount = uint256(uint128(bytes16(_data[56:72])));
        hopData.destinationAmountOutMin = uint256(
            uint128(bytes16(_data[72:88]))
        );
        // relayer = address(bytes20(_data[88:108]));
        // relayerFee = uint256(uint128(bytes16(_data[108:124])));
        hopData.hopBridge = IHopBridge(address(bytes20(_data[124:144])));

        return (bridgeData, hopData);
    }
}
