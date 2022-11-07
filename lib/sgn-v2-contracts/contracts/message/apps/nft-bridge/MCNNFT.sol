// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.9;

import "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import "../../../safeguard/Pauser.sol";

interface INFTBridge {
    function sendMsg(
        uint64 _dstChid,
        address _sender,
        address _receiver,
        uint256 _id,
        string calldata _uri
    ) external payable;

    function sendMsg(
        uint64 _dstChid,
        address _sender,
        bytes calldata _receiver,
        uint256 _id,
        string calldata _uri
    ) external payable;

    function totalFee(
        uint64 _dstChid,
        address _nft,
        uint256 _id
    ) external view returns (uint256);
}

// Multi-Chain Native NFT, same contract on all chains. User interacts with this directly.
contract MCNNFT is ERC721URIStorage, Pauser {
    event NFTBridgeUpdated(address);
    address public nftBridge;

    constructor(
        string memory name_,
        string memory symbol_,
        address _nftBridge
    ) ERC721(name_, symbol_) {
        nftBridge = _nftBridge;
    }

    modifier onlyNftBridge() {
        require(msg.sender == nftBridge, "caller is not bridge");
        _;
    }

    function bridgeMint(
        address to,
        uint256 id,
        string memory uri
    ) external onlyNftBridge {
        _mint(to, id);
        _setTokenURI(id, uri);
    }

    // calls nft bridge to get total fee for crossChain msg.Value
    function totalFee(uint64 _dstChid, uint256 _id) external view returns (uint256) {
        return INFTBridge(nftBridge).totalFee(_dstChid, address(this), _id);
    }

    // called by user, burn token on this chain and mint same id/uri on dest chain
    function crossChain(
        uint64 _dstChid,
        uint256 _id,
        address _receiver
    ) external payable whenNotPaused {
        require(msg.sender == ownerOf(_id), "not token owner");
        string memory _uri = tokenURI(_id);
        _burn(_id);
        INFTBridge(nftBridge).sendMsg{value: msg.value}(_dstChid, msg.sender, _receiver, _id, _uri);
    }

    // support chains using bytes for address
    function crossChain(
        uint64 _dstChid,
        uint256 _id,
        bytes calldata _receiver
    ) external payable whenNotPaused {
        require(msg.sender == ownerOf(_id), "not token owner");
        string memory _uri = tokenURI(_id);
        _burn(_id);
        INFTBridge(nftBridge).sendMsg{value: msg.value}(_dstChid, msg.sender, _receiver, _id, _uri);
    }

    // ===== only Owner
    function mint(
        address to,
        uint256 id,
        string memory uri
    ) external onlyOwner {
        _mint(to, id);
        _setTokenURI(id, uri);
    }

    function setNFTBridge(address _newBridge) public onlyOwner {
        nftBridge = _newBridge;
        emit NFTBridgeUpdated(_newBridge);
    }
}
