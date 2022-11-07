// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.9;

import "../../framework/MessageReceiverApp.sol";
import "../../interfaces/IMessageBus.sol";
import "../../../safeguard/Pauser.sol";

// interface for NFT contract, ERC721 and metadata, only funcs needed by NFTBridge
interface INFT {
    function tokenURI(uint256 tokenId) external view returns (string memory);

    function ownerOf(uint256 tokenId) external view returns (address owner);

    // we do not support NFT that charges transfer fees
    function transferFrom(
        address from,
        address to,
        uint256 tokenId
    ) external;

    // impl by NFToken contract, mint an NFT with id and uri to user or burn
    function bridgeMint(
        address to,
        uint256 id,
        string memory uri
    ) external;

    function burn(uint256 id) external;
}

/** @title NFT Bridge */
contract NFTBridge is MessageReceiverApp, Pauser {
    /// per dest chain id executor fee in this chain's gas token
    mapping(uint64 => uint256) public destTxFee;
    /// per dest chain id NFTBridge address
    mapping(uint64 => address) public destBridge;
    /// first key is NFT address on this chain, 2nd key is dest chain id, value is address on dest chain
    mapping(address => mapping(uint64 => address)) public destNFTAddr;

    /// only set to true if NFT addr on this chain is the orig, so we will use deposit/withdraw instead of burn/mint.
    /// not applicable for mcn nft (always burn/mint)
    mapping(address => bool) public origNFT;

    /// only for non-evm chains and address can't fit 20bytes
    mapping(uint64 => bytes) public destBridge2;
    mapping(address => mapping(uint64 => bytes)) public destNFTAddr2;

    struct NFTMsg {
        address user; // receiver of minted or withdrawn NFT
        address nft; // NFT contract on mint/withdraw chain
        uint256 id; // token ID
        string uri; // tokenURI from source NFT
    }
    // for non-evm dst chain, address type is bytes
    struct NFTMsg2 {
        bytes user; // receiver of minted or withdrawn NFT
        bytes nft; // NFT contract on mint/withdraw chain
        uint256 id; // token ID
        string uri; // tokenURI from source NFT
    }
    // emit in deposit or burn
    event Sent(address sender, address srcNft, uint256 id, uint64 dstChid, address receiver, address dstNft);
    // bytes type for receiver and dstNft
    event Sent2(address sender, address srcNft, uint256 id, uint64 dstChid, bytes receiver, bytes dstNft);
    // emit for mint or withdraw message
    event Received(address receiver, address nft, uint256 id, uint64 srcChid);

    // emit when params change
    event SetDestNFT(address srcNft, uint64 dstChid, address dstNft);
    event SetTxFee(uint64 chid, uint256 fee);
    event SetDestBridge(uint64 dstChid, address dstNftBridge);
    event FeeClaimed(uint256 amount);
    event SetOrigNFT(address nft, bool isOrig);
    // emit if executeMessage calls nft transfer or bridgeMint returns error
    event ExtCallErr(bytes returnData);

    event SetDestNFT2(address srcNft, uint64 dstChid, bytes dstNft);
    event SetDestBridge2(uint64 dstChid, bytes dstNftBridge);

    constructor(address _msgBus) {
        messageBus = _msgBus;
    }

    // only to be called by Proxy via delegatecall and will modify Proxy state
    // initOwner will fail if owner is already set, so only delegateCall will work
    function init(address _msgBus) external {
        initOwner();
        messageBus = _msgBus;
    }

    /**
     * @notice totalFee returns gas token value to be set in user tx, includes both msg fee and executor fee for dest chain
     * @dev we assume if dst chain address are bytes, user and nft are same length, otherwise we need to add receiver to args
     * @param _dstChid dest chain ID
     * @param _nft address of source NFT contract
     * @param _id token ID to bridge (need to get accurate tokenURI length)
     * @return total fee needed for user tx
     */
    function totalFee(
        uint64 _dstChid,
        address _nft,
        uint256 _id
    ) external view returns (uint256) {
        string memory _uri = INFT(_nft).tokenURI(_id);
        bytes memory message;
        // try non-evm first
        bytes memory dstNft = destNFTAddr2[_nft][_dstChid];
        if (dstNft.length > 0) {
            message = abi.encode(NFTMsg2(dstNft, dstNft, _id, _uri));
        } else {
            // evm chains or not configured, assume to be evm, 20 bytes address
            message = abi.encode(NFTMsg(_nft, _nft, _id, _uri));
        }
        return IMessageBus(messageBus).calcFee(message) + destTxFee[_dstChid];
    }

    // ===== called by user
    /**
     * @notice locks or burn user's NFT in this contract and send message to mint (or withdraw) on dest chain
     * @param _nft address of source NFT contract
     * @param _id nft token ID to bridge
     * @param _dstChid dest chain ID
     * @param _receiver receiver address on dest chain
     */
    function sendTo(
        address _nft,
        uint256 _id,
        uint64 _dstChid,
        address _receiver
    ) external payable whenNotPaused {
        require(msg.sender == INFT(_nft).ownerOf(_id), "not token owner");
        // must save _uri before burn
        string memory _uri = INFT(_nft).tokenURI(_id);
        lockOrBurn(_nft, _id);
        (address _dstBridge, address _dstNft) = checkAddr(_nft, _dstChid);
        msgBus(_dstBridge, _dstChid, abi.encode(NFTMsg(_receiver, _dstNft, _id, _uri)));
        emit Sent(msg.sender, _nft, _id, _dstChid, _receiver, _dstNft);
    }

    /**
     * @notice locks or burn user's NFT in this contract and send message to mint (or withdraw) on dest chain
     * @param _nft address of source NFT contract
     * @param _id nft token ID to bridge
     * @param _dstChid dest chain ID
     * @param _receiver receiver address on dest chain, arbitrary bytes
     */
    function sendTo(
        address _nft,
        uint256 _id,
        uint64 _dstChid,
        bytes calldata _receiver
    ) external payable whenNotPaused {
        require(msg.sender == INFT(_nft).ownerOf(_id), "not token owner");
        // must save _uri before burn
        string memory _uri = INFT(_nft).tokenURI(_id);
        lockOrBurn(_nft, _id);
        (bytes memory _dstBridge, bytes memory _dstNft) = checkAddr2(_nft, _dstChid);
        msgBus(_dstBridge, _dstChid, abi.encode(NFTMsg2(_receiver, _dstNft, _id, _uri)));
        emit Sent2(msg.sender, _nft, _id, _dstChid, _receiver, _dstNft);
    }

    // ===== called by MCN NFT after NFT is burnt
    function sendMsg(
        uint64 _dstChid,
        address _sender,
        address _receiver,
        uint256 _id,
        string calldata _uri
    ) external payable whenNotPaused {
        address _nft = msg.sender;
        (address _dstBridge, address _dstNft) = checkAddr(_nft, _dstChid);
        msgBus(_dstBridge, _dstChid, abi.encode(NFTMsg(_receiver, _dstNft, _id, _uri)));
        emit Sent(_sender, _nft, _id, _dstChid, _receiver, _dstNft);
    }

    // for non-evm chains and address can't fit 20bytes or non-hex
    function sendMsg(
        uint64 _dstChid,
        address _sender,
        bytes calldata _receiver,
        uint256 _id,
        string calldata _uri
    ) external payable whenNotPaused {
        address _nft = msg.sender;
        (bytes memory _dstBridge, bytes memory _dstNft) = checkAddr2(_nft, _dstChid);
        msgBus(_dstBridge, _dstChid, abi.encode(NFTMsg2(_receiver, _dstNft, _id, _uri)));
        emit Sent2(_sender, _nft, _id, _dstChid, _receiver, _dstNft);
    }

    // ===== called by msgbus
    function executeMessage(
        address sender,
        uint64 srcChid,
        bytes calldata _message,
        address // executor
    ) external payable override onlyMessageBus returns (ExecutionStatus) {
        // Must check sender to ensure msg is from another nft bridge
        // but we allow retry later in case it's a temporary config error
        // risk is invalid sender will be retried but this can be easily filtered
        // in executor or require manual trigger for retry
        if (paused() || sender != destBridge[srcChid]) {
            return ExecutionStatus.Retry;
        }
        return xferOrMint(_message, srcChid);
    }

    function executeMessage(
        bytes calldata sender,
        uint64 srcChid,
        bytes calldata _message,
        address // executor
    ) external payable override onlyMessageBus returns (ExecutionStatus) {
        if (paused() || keccak256(sender) != keccak256(destBridge2[srcChid])) {
            return ExecutionStatus.Retry;
        }
        return xferOrMint(_message, srcChid);
    }

    // ===== internal utils
    // lockOrBurn on sender side
    function lockOrBurn(address _nft, uint256 _id) internal {
        if (origNFT[_nft] == true) {
            // deposit
            INFT(_nft).transferFrom(msg.sender, address(this), _id);
            require(INFT(_nft).ownerOf(_id) == address(this), "transfer NFT failed");
        } else {
            // burn
            INFT(_nft).burn(_id);
        }
    }

    // xferOrMint on receiver side, transfer or mint NFT to receiver
    function xferOrMint(bytes calldata _message, uint64 srcChid) internal returns (ExecutionStatus) {
        // withdraw original locked nft back to user, or mint new nft depending on if this is the orig chain of nft
        NFTMsg memory nftMsg = abi.decode((_message), (NFTMsg));
        // if we are on nft orig chain, use transfer, otherwise, use mint
        // we must never return fail because burnt nft will be lost forever
        if (origNFT[nftMsg.nft] == true) {
            try INFT(nftMsg.nft).transferFrom(address(this), nftMsg.user, nftMsg.id) {
                // do nothing here to move on to emit Received event and return success
            } catch (bytes memory returnData) {
                emit ExtCallErr(returnData);
                return ExecutionStatus.Retry;
            }
        } else {
            try INFT(nftMsg.nft).bridgeMint(nftMsg.user, nftMsg.id, nftMsg.uri) {
                // do nothing here to move on to emit Received event and return success
            } catch (bytes memory returnData) {
                emit ExtCallErr(returnData);
                return ExecutionStatus.Retry;
            }
        }
        emit Received(nftMsg.user, nftMsg.nft, nftMsg.id, srcChid);
        return ExecutionStatus.Success;
    }

    // check _nft and destChid are valid, return dstBridge and dstNft
    function checkAddr(address _nft, uint64 _dstChid) internal view returns (address dstBridge, address dstNft) {
        dstBridge = destBridge[_dstChid];
        require(dstBridge != address(0), "dest NFT Bridge not found");
        dstNft = destNFTAddr[_nft][_dstChid];
        require(dstNft != address(0), "dest NFT not found");
    }

    function checkAddr2(address _nft, uint64 _dstChid)
        internal
        view
        returns (bytes memory dstBridge, bytes memory dstNft)
    {
        dstBridge = destBridge2[_dstChid];
        require(dstBridge.length != 0, "dest NFT Bridge not found");
        dstNft = destNFTAddr2[_nft][_dstChid];
        require(dstNft.length != 0, "dest NFT not found");
    }

    // check fee and call msgbus sendMessage
    function msgBus(
        address _dstBridge,
        uint64 _dstChid,
        bytes memory message
    ) internal {
        uint256 fee = IMessageBus(messageBus).calcFee(message);
        require(msg.value >= fee + destTxFee[_dstChid], "insufficient fee");
        IMessageBus(messageBus).sendMessage{value: fee}(_dstBridge, _dstChid, message);
    }

    function msgBus(
        bytes memory _dstBridge,
        uint64 _dstChid,
        bytes memory message
    ) internal {
        uint256 fee = IMessageBus(messageBus).calcFee(message);
        require(msg.value >= fee + destTxFee[_dstChid], "insufficient fee");
        IMessageBus(messageBus).sendMessage{value: fee}(_dstBridge, _dstChid, message);
    }

    // only owner
    // set per NFT, per chain id, address
    function setDestNFT(
        address srcNft,
        uint64 dstChid,
        address dstNft
    ) external onlyOwner {
        destNFTAddr[srcNft][dstChid] = dstNft;
        emit SetDestNFT(srcNft, dstChid, dstNft);
    }

    // add to destNFTAddr2
    function setDestNFT(
        address srcNft,
        uint64 dstChid,
        bytes calldata dstNft
    ) external onlyOwner {
        destNFTAddr2[srcNft][dstChid] = dstNft;
        emit SetDestNFT2(srcNft, dstChid, dstNft);
    }

    // set all dest chains
    function setDestNFTs(
        address srcNft,
        uint64[] calldata dstChid,
        address[] calldata dstNft
    ) external onlyOwner {
        require(dstChid.length == dstNft.length, "length mismatch");
        for (uint256 i = 0; i < dstChid.length; i++) {
            destNFTAddr[srcNft][dstChid[i]] = dstNft[i];
        }
    }

    // set destTxFee
    function setTxFee(uint64 chid, uint256 fee) external onlyOwner {
        destTxFee[chid] = fee;
        emit SetTxFee(chid, fee);
    }

    // set per chain id, nft bridge address
    function setDestBridge(uint64 dstChid, address dstNftBridge) external onlyOwner {
        destBridge[dstChid] = dstNftBridge;
        emit SetDestBridge(dstChid, dstNftBridge);
    }

    function setDestBridge(uint64 dstChid, bytes calldata dstNftBridge) external onlyOwner {
        destBridge2[dstChid] = dstNftBridge;
        emit SetDestBridge2(dstChid, dstNftBridge);
    }

    // batch set nft bridge addresses for multiple chainids
    function setDestBridges(uint64[] calldata dstChid, address[] calldata dstNftBridge) external onlyOwner {
        for (uint256 i = 0; i < dstChid.length; i++) {
            destBridge[dstChid[i]] = dstNftBridge[i];
        }
    }

    // only called on NFT's orig chain, not applicable for mcn nft
    function setOrigNFT(address _nft) external onlyOwner {
        origNFT[_nft] = true;
        emit SetOrigNFT(_nft, true);
    }

    // remove origNFT entry
    function delOrigNFT(address _nft) external onlyOwner {
        delete origNFT[_nft];
        emit SetOrigNFT(_nft, false);
    }

    // send all gas token this contract has to owner
    function claimFee() external onlyOwner {
        uint256 amount = address(this).balance;
        payable(msg.sender).transfer(amount);
        emit FeeClaimed(amount);
    }
}
