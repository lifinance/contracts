# Standardized Call Facet

## How it works

The StandardizedCallFacet Facet works by parsing the calldata sent to standardizedCall and then forwarding to the correct facet using the LiFiDiamond internal storage for facet address lookup.

```mermaid
graph LR;
    D{LiFiDiamond}-- DELEGATECALL -->StandardizedCallFacetFacet;
    StandardizedCallFacetFacet -- CALL --> C(StandardizedCallFacet)
```

## Public Methods

- `function standardizedCall(bytes calldata callData)`
  - Calls the correct facet based on the calldata.
