// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.9;

import "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import "../../../safeguard/Ownable.sol";

contract OrigNFT is ERC721URIStorage, Ownable {
    constructor(string memory name_, string memory symbol_) ERC721(name_, symbol_) {}

    function mint(
        address to,
        uint256 id,
        string memory uri
    ) external onlyOwner {
        _mint(to, id);
        _setTokenURI(id, uri);
    }
}
