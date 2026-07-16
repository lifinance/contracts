# Cross Cutting — past findings

## LF-039 · LOW · GasZipFacet, GasZipPeriphery · acknowledged

**Recognition signal:** Forwarding user-supplied amounts to an external partner that has documented input bounds, without enforcing those bounds in the smart contract layer.

**Root cause:** Gas.zip documents per-chain deposit limits ($0.25-$50 USD), but neither GasZipFacet nor GasZipPeriphery enforces these bounds on-chain, so out-of-range amounts can reach the router and be rejected or behave unexpectedly off-chain.

**Fix:** Acknowledged: limits are enforced at the LI.FI backend rather than on-chain.

**Source:** `2025.01.10_Cantina_PreComp.pdf` p.5-5 · `audit20250110_1::3.2.1`
