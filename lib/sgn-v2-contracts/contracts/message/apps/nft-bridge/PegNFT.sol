// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.9;

import "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";

contract PegNFT is ERC721URIStorage {
    address public immutable nftBridge;

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

    function burn(uint256 id) external onlyNftBridge {
        _burn(id);
    }
}
