// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import {LiFiDiamond} from "../src/LiFiDiamond.sol";

// Violación: Facet sin nombre "Facet"
// Violación: Falta función _startBridge requerida
// Violación: Falta swapAndStartBridgeTokensVia{FacetName}
// Violación: Falta startBridgeTokensVia{FacetName}
// Violación: Falta modifier nonReentrant
// Violación: Falta modifier refundExcessNative
// Violación: Falta modifier validateBridgeData
contract BadBridgeFacet {
    // Violación: receiverAddress no es el primer parámetro
    struct BadBridgeData {
        uint256 amount;
        address receiverAddress; // Debería ser primero
    }
    
    // Violación: No usa LibAsset/LibSwap/LibAllowList
    // Violación: No delega a librerías
    function bridgeTokens(BadBridgeData memory data) public {
        // Lógica inline en lugar de usar librerías
        // Violación: No emite LiFiTransferStarted al final de _startBridge
    }
}
