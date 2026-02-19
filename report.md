# FeeCollector Balance Audit Report

Generated: 2026-02-19T10:56:49.169Z

## Terminology

- **Missing** — Current balance &lt; Expected (collected − withdrawn). The contract holds less than the events say it should (shortfall). The table below lists only these tokens.
- **Total affected** — All tokens on that chain where expected ≠ actual (missing + surplus). Surplus = Current balance &gt; Expected.
- **Remaining balance in FeeCollector (USD)** — For problematic (missing) tokens only: USD value of the current balance still held in the FeeCollector contract (value at risk). Summed per chain; only tokens with a known price are included.

## Column reference (how to read the Affected Tokens table)

| Column | What it means |
| ------ | ------------- |
| **Chain** | Network (arbitrum, base, mainnet). |
| **Token address** | Contract address of the token. |
| **Symbol** | Token symbol. |
| **Collected** | Total credited from FeesCollected (integratorFee + lifiFee). |
| **Withdrawn** | Total sent out from FeesWithdrawn + LiFiFeesWithdrawn. |
| **Expected (collected - withdrawn)** | What the events say should still be in the contract. |
| **Current balance** | What the contract actually holds (balanceOf(FeeCollector)). |
| **Missing amount** | Shortfall: Expected − Current balance (in token units). |
| **Missing USD** | Same shortfall in USD (or N/A if no price). |
| **Note** | e.g. "balanceOf reverted" when the token contract reverted on balanceOf (actual treated as 0). |

## Summary

- **Total missing (USD):** 16195.38

- **mainnet:** 8 Missing (Current balance &lt; Expected), 289 total affected (missing + surplus), missing USD: 2.53, tokens scanned: 3284
- **polygon:** 6 Missing (Current balance &lt; Expected), 125 total affected (missing + surplus), missing USD: 0.01, tokens scanned: 1824
- **arbitrum:** 3 Missing (Current balance &lt; Expected), 39 total affected (missing + surplus), missing USD: 0.10, tokens scanned: 937
- **optimism:** 15 Missing (Current balance &lt; Expected), 120 total affected (missing + surplus), missing USD: 16133.91, tokens scanned: 129
- **base:** 17 Missing (Current balance &lt; Expected), 1095 total affected (missing + surplus), missing USD: 0.29, tokens scanned: 7744
- **bsc:** 12 Missing (Current balance &lt; Expected), 194 total affected (missing + surplus), missing USD: 22.44, tokens scanned: 6590
- **zksync:** 1 Missing (Current balance &lt; Expected), 6 total affected (missing + surplus), missing USD: 36.09, tokens scanned: 154

### Summary table (per chain)

| Chain     | Tokens fees collected in | Tokens with missing funds | Tokens without price | Missing funds in USD | Remaining balance in FeeCollector (USD) |                 Note |
| --------- | ------------------------ | ------------------------- | -------------------- | -------------------- | --------------------------------------- | -------------------- |
| mainnet   |                     3284 |                         8 |                    1 |                 2.53 |                                  565.45 |                      |
| polygon   |                     1824 |                         6 |                    0 |                 0.01 |                                    0.01 |                      |
| arbitrum  |                      937 |                         3 |                    2 |                 0.10 |                                    0.00 |                      |
| optimism  |                      129 |                        15 |                    1 |             16133.91 |                                    1.76 |                      |
| base      |                     7744 |                        17 |                   12 |                 0.29 |                                    1.10 | excluding USDC & ETH |
| bsc       |                     6590 |                        12 |                    5 |                22.44 |                                    0.04 |                      |
| zksync    |                      154 |                         1 |                    0 |                36.09 |                                    2.14 |                      |
| **Total** |                    20662 |                        62 |                   21 |             16195.38 |                                  570.51 |                      |


> **⚠️ Validation: standard (no-tax) tokens listed as missing** — The following tokens do not have transfer taxes (fee-on-transfer): **FRAX**. For such tokens, a reported shortfall often indicates **incomplete event data**, not on-chain accounting. Many RPCs limit `eth_getLogs` to 10,000 logs per request; with a large block chunk, withdrawals can be truncated so "expected" is overstated. Re-run `--step collect` with `--chunk-size 2000` (or smaller), then reconcile and report again; if the discrepancy disappears, it was due to incomplete events.

## Affected Tokens

| Chain    | Token address                              | Symbol           |                          Collected |               Withdrawn |                           Expected |         Current balance |                     Missing amount | Missing USD | Note               |
| -------- | ------------------------------------------ | ---------------- | ---------------------------------- | ----------------------- | ---------------------------------- | ----------------------- | ---------------------------------- | ----------- | ------------------ |
| mainnet  | 0x4a220E6096B25EADb88358cb44068A3248254675 | QNT              |              66.847425590923425858 |   58.790115942136650756 |               8.057309648786775102 |    8.049526948416980899 |               0.007782700369794203 |        0.54 |                    |
| mainnet  | 0x59D9356E565Ab3A36dD77763Fc0d87fEaf85508C | USDM             |              11.489277221037467536 |   11.481745941776815773 |               0.007531279260651763 |    0.007531279260651762 |               0.000000000000000001 |        0.00 |                    |
| mainnet  | 0xD46bA6D942050d489DBd938a2C909A5d5039A161 | AMPL             |                        6.563691518 |             0.000000000 |                        6.563691518 |             4.941901897 |                        1.621789621 |        1.99 |                    |
| mainnet  | 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 | UNKNOWN          |               0.000000000020000000 |    0.000000000000000000 |               0.000000000020000000 |    0.000000000000000000 |               0.000000000020000000 |         N/A |                    |
| mainnet  | 0xeDe0a3332BB2A3bD73C50e4055f52F14d00443ba | YETI             |                      810.779853525 |             0.000000000 |                      810.779853525 |           106.000000000 |                      704.779853525 |        0.00 |                    |
| mainnet  | 0xc845b2894dBddd03858fd2D643B4eF725fE0849d | NVDAx            |               0.001828541795306735 |    0.000000000000000000 |               0.001828541795306735 |    0.001828541795306734 |               0.000000000000000001 |        0.00 |                    |
| mainnet  | 0xD22230583555AC60c604A3FE4dF36A665770c69D | MADURO           |                     1559.964736839 |             0.000000000 |                     1559.964736839 |           190.000000000 |                     1369.964736839 |        0.00 |                    |
| mainnet  | 0xbD6323A83b613F668687014E8A5852079494fB68 | BTC              |            1712.190176661663174894 |    0.000000000000000000 |            1712.190176661663174894 | 1712.190176661663174893 |               0.000000000000000001 |        0.00 |                    |
| polygon  | 0x236eeC6359fb44CCe8f97E99387aa7F8cd5cdE1f | USD+             |                          27.395563 |               25.671585 |                           1.723978 |                0.000000 |                           1.723978 |        0.00 |                    |
| polygon  | 0x81eE105457C4EafC061B8C8FeDC7BB45d22286d2 | XUSD             |               0.024000000000000000 |    0.000000000000000000 |               0.024000000000000000 |    0.000008606391603504 |               0.023991393608396496 |        0.01 |                    |
| polygon  | 0xE554E874c9c60E45F1Debd479389C76230ae25A8 | oMATIC           |                         0.00002200 |              0.00000000 |                         0.00002200 |              0.00000000 |                         0.00002200 |        0.00 |                    |
| polygon  | 0xA04C86c411320444d4A99d44082e057772E8cF96 | WUSD             |                           0.002250 |                0.000000 |                           0.002250 |                0.000000 |                           0.002250 |        0.00 |                    |
| polygon  | 0x4CFe63294dac27cE941d42A778A37F2b35fea21b | ETUS             |            1688.786995026752844928 |    0.000000000000000000 |            1688.786995026752844928 | 1685.348799203759994768 |               3.438195822992850160 |        0.00 |                    |
| polygon  | 0x38d693cE1dF5AaDF7bC62595A37D667aD57922e5 | aPolEURS         |                               0.37 |                    0.30 |                               0.07 |                    0.06 |                               0.01 |        0.00 |                    |
| arbitrum | 0x727354712BDFcd8596a3852Fd2065b3C34F4F770 | rWBTC            |                         0.00000072 |              0.00000061 |                         0.00000011 |              0.00000000 |                         0.00000011 |         N/A | balanceOf reverted |
| arbitrum | 0x0dF5dfd95966753f01cb80E76dc20EA958238C46 | rWETH            |               0.000002904803862836 |    0.000000000000000000 |               0.000002904803862836 |    0.000000000000000000 |               0.000002904803862836 |         N/A | balanceOf reverted |
| arbitrum | 0x8096aD3107715747361acefE685943bFB427C722 | CVI              |               0.000783841087137249 |    0.000000000000000000 |               0.000783841087137249 |    0.000002412470504150 |               0.000781428616633099 |        0.10 |                    |
| optimism | 0x2416092f143378750bb29b79eD961ab195CcEea5 | ezETH            |               0.000625829250257843 |    0.000206574467521935 |               0.000419254782735908 |    0.000370430878169610 |               0.000048823904566298 |        0.10 |                    |
| optimism | 0x2E3D870790dC77A83DD1d18184Acc7439A53f475 | FRAX             |               1.098605332940000000 |    0.000000000000000000 |               1.098605332940000000 |    0.412402805946741260 |               0.686202526993258740 |        0.67 |                    |
| optimism | 0x73cb180bf0521828d8849bc8CF2B920918e23032 | USD+             |                           0.006104 |                0.002093 |                           0.004011 |                0.000000 |                           0.004011 |        0.00 |                    |
| optimism | 0xDecC0c09c3B5f6e92EF4184125D5648a66E35298 | S*USDC           |                           0.017768 |                0.000879 |                           0.016889 |                0.006813 |                           0.010076 |        0.10 |                    |
| optimism | 0xc45A479877e1e9Dfe9FcD4056c699575a1045dAA | aOptwstETH       |               0.000227800000000000 |    0.000000000000000000 |               0.000227800000000000 |    0.000148995172724870 |               0.000078804827275130 |        0.19 |                    |
| optimism | 0x3E29D3A9316dAB217754d13b28646B76607c5f04 | alETH            |               0.000180233031226146 |    0.000014231531885211 |               0.000166001499340935 |    0.000053369120228630 |               0.000112632379112305 |        0.21 |                    |
| optimism | 0xE405de8F52ba7559f9df3C368500B6E6ae6Cee49 | sETH             |               0.000036227524356679 |    0.000005464435381738 |               0.000030763088974941 |    0.000000882487581717 |               0.000029880601393224 |        0.03 |                    |
| optimism | 0xba1Cf949c382A32a09A17B2AdF3587fc7fA664f1 | SOL              |                        0.000025000 |             0.000000000 |                        0.000025000 |             0.000000000 |                        0.000025000 |        0.00 |                    |
| optimism | 0xC81D1F0EB955B0c020E5d5b264E1FF72c14d1401 | RPL              |               0.124642163325937489 |    0.000000000000000000 |               0.124642163325937489 |    0.000000000000000000 |               0.124642163325937489 |    16131.91 |                    |
| optimism | 0xFA436399d0458Dbe8aB890c3441256E3E09022a8 | ZIP              |               0.300000000000000000 |    0.000000000000000000 |               0.300000000000000000 |    0.000000000000000000 |               0.300000000000000000 |        0.00 |                    |
| optimism | 0xEB466342C4d449BC9f53A865D5Cb90586f405215 | axlUSDC          |                           0.709695 |                0.000000 |                           0.709695 |                0.040959 |                           0.668736 |        0.67 |                    |
| optimism | 0x0000206329b97DB379d5E1Bf586BbDB969C63274 | USDA             |               0.001738534023867249 |    0.000000000000000000 |               0.001738534023867249 |    0.000869267011933624 |               0.000869267011933625 |        0.00 |                    |
| optimism | 0xa211E25F7246950E0cCe054e3161C7c0b6379485 | IPT              |               0.050201244663674095 |    0.000000000000000000 |               0.050201244663674095 |    0.000000000000000000 |               0.050201244663674095 |        0.00 |                    |
| optimism | 0x8B21e9b7dAF2c4325bf3D18c1BeB79A347fE902A | COLLAB           |              35.889257653967813454 |    0.000000000000000000 |              35.889257653967813454 |    0.000002241411432331 |              35.889255412556381123 |        0.00 |                    |
| optimism | 0xa50B23cDfB2eC7c590e84f403256f67cE6dffB84 | BLU              |            5004.486624487398492225 |    0.000000000000000000 |            5004.486624487398492225 |    0.000000000000000000 |            5004.486624487398492225 |         N/A |                    |
| base     | 0x3421cc14F0e3822Cf3B73C3a4BEC2A1023b8d9Cf | Rebase           |                        0.337487938 |             0.046791479 |                        0.290696459 |             0.015008838 |                        0.275687621 |        0.25 |                    |
| base     | 0x938171227eCE879267122a36847B219cbd3B9D47 | AI               | 873693700220012.990333164474343083 | 3008.671872163833505013 | 873693700217004.318461000640838070 |    0.850200000000000000 | 873693700217003.468261000640838070 |        0.00 |                    |
| base     | 0x19C34C671EC51C68482E85e835663E401aF17A7C | happycat         |                      233.388805822 |             0.000000000 |                      233.388805822 |             0.000000000 |                      233.388805822 |         N/A |                    |
| base     | 0xf03A3A3C054447bE73574F5bfe1ac52156Dbf6F4 | INIT             |               0.001388642421229212 |    0.000000000000000000 |               0.001388642421229212 |    0.000000000000000000 |               0.001388642421229212 |         N/A |                    |
| base     | 0x680a3a5343624F437d98a4e0bE75Cd26D96c8006 | SNS              |               0.050689380498130628 |    0.000000000000000000 |               0.050689380498130628 |    0.000000000000000000 |               0.050689380498130628 |         N/A |                    |
| base     | 0xAA79cB818Da9f8076fa737443e7F49588Fe53138 | kekius           |                       65.753623398 |             0.000000000 |                       65.753623398 |            60.393632917 |                        5.359990481 |         N/A |                    |
| base     | 0xae0C6Ff3cA01B05F86785224dd37e7eDe16A3737 | TRUMP2028        |                      358.872855172 |             0.000000000 |                      358.872855172 |             0.000000000 |                      358.872855172 |         N/A |                    |
| base     | 0x3205b8E9403F9a4F48b6693fcEC6812604136c51 | Mars             |                       31.450801315 |             0.000000000 |                       31.450801315 |             0.000000000 |                       31.450801315 |         N/A |                    |
| base     | 0xFc85882D6c1D9871F341b0f454569351FC5FaF75 | BABYDOGE         |                        7.905140854 |             0.000000000 |                        7.905140854 |             0.000000000 |                        7.905140854 |         N/A |                    |
| base     | 0x0987689aA8b7Bf4d990552599069ce5Fb99CCA0a | Stock            |               0.008013987676159961 |    0.000000000000000000 |               0.008013987676159961 |    0.005957167350974109 |               0.002056820325185852 |         N/A |                    |
| base     | 0x080E7a2DC05221B05f22C605056BDE92e56Da73b | HOOD             |               0.002037640169524142 |    0.000000000000000000 |               0.002037640169524142 |    0.002009212209974145 |               0.000028427959549997 |         N/A |                    |
| base     | 0x82aA9BE410a7EFB1D112C05A500d58cBf372a4E0 | HOOD             |              95.167347260075907481 |    0.000000000000000000 |              95.167347260075907481 |    0.000000000000000000 |              95.167347260075907481 |         N/A |                    |
| base     | 0x5F5668D7C748Fc1A17540C3a7f9245d8CeA10C29 | MACRO            |            3560.781119071927951808 |   55.812173867000000000 |            3504.968945204927951808 | 3401.327954946953636342 |             103.640990257974315466 |        0.03 |                    |
| base     | 0x798982559ce29d25385090C438087D2aB2e19Fb6 | TOWNS            |                     5676.728257453 |             0.000000000 |                     5676.728257453 |             0.000098904 |                     5676.728158549 |         N/A |                    |
| base     | 0xAe2E0060B2781c7d19236Aa6dfF3029A57D13f40 | Flash USDT fUSDT |              25.000000000000000000 |    0.000000000000000000 |              25.000000000000000000 |    0.000000000000000000 |              25.000000000000000000 |         N/A |                    |
| base     | 0x25Bb8D9eB53eEe8b899ff9E8c9c78674Ce8b9937 | $DFY             |             180.788775000000000000 |    0.000000000000000000 |             180.788775000000000000 |    0.000000000000000000 |             180.788775000000000000 |        0.00 |                    |
| base     | 0x042C32942362A3d18336B17CF48052FA8800Dd21 | CRCL             |               0.359974790057995311 |    0.000000000000000000 |               0.359974790057995311 |    0.003599747900579953 |               0.356375042157415358 |        0.00 |                    |
| bsc      | 0xe80772Eaf6e2E18B651F160Bc9158b2A5caFCA65 | USD+             |                           7.393555 |                1.198220 |                           6.195335 |                0.000000 |                           6.195335 |        4.49 |                    |
| bsc      | 0xE499d44285dCaCf456D8b105aBDd0B2CAEed0000 | ZRO              |             217.748808126609026720 |    0.000000000000000000 |             217.748808126609026720 |    0.000000000000000000 |             217.748808126609026720 |        0.00 |                    |
| bsc      | 0x5335E87930b410b8C5BB4D43c3360ACa15ec0C8C | USDT+            |              29.677930322339621793 |   11.396917185367383595 |              18.281013136972238198 |    0.000000000000000000 |              18.281013136972238198 |       17.95 |                    |
| bsc      | 0xCE1b3e5087e8215876aF976032382dd338cF8401 | THOREUM          |               0.000020181493198922 |    0.000000000000000000 |               0.000020181493198922 |    0.000017979856908635 |               0.000002201636290287 |        0.00 |                    |
| bsc      | 0xB1ff83EF5e44862d634413Be77cA4dC6AC50B74F | CUT              |                     1001.993358353 |             0.000000000 |                     1001.993358353 |          1001.993358352 |                        0.000000001 |        0.00 |                    |
| bsc      | 0x58b0BB56CFDfc5192989461dD43568bcfB2797Db | rWBNB            |               0.000010633111375932 |    0.000000000000000000 |               0.000010633111375932 |    0.000000000000000000 |               0.000010633111375932 |         N/A | balanceOf reverted |
| bsc      | 0x34d4F4459c1b529BEbE1c426F1e584151BE2C1e5 | rBTCB            |               0.000000162188038576 |    0.000000000000000000 |               0.000000162188038576 |    0.000000000000000000 |               0.000000162188038576 |         N/A | balanceOf reverted |
| bsc      | 0xd6C18237463f0Db55620f575feab1dE691183041 | ＵЅᎠТ             |               0.000030000000000000 |    0.000000000000000000 |               0.000030000000000000 |    0.000000000000000000 |               0.000030000000000000 |        0.00 |                    |
| bsc      | 0x8aDCeb96B3c89B10Cf1Df21683F32F6CDDdeC483 | ROCKET           |        10000000.000000000000000000 |    0.000000000000000000 |        10000000.000000000000000000 |    0.000001000000000000 |         9999999.999999000000000000 |        0.00 |                    |
| bsc      | 0x8Ea2f890CB86DFb0E376137451c6fD982AFefc15 | UNKNOWN          |             235.164629450977451126 |  222.172110037213844882 |              12.992519413763606244 |    0.000000000000000000 |              12.992519413763606244 |         N/A | balanceOf reverted |
| bsc      | 0xDB021b1B247fe2F1fa57e0A87C748Cc1E321F07F | AMPL             |                        0.025023385 |             0.000000000 |                        0.025023385 |             0.014524114 |                        0.010499271 |         N/A |                    |
| bsc      | 0xF9A8E4579DAF406b3E4d7DF591432bC8e97C4444 | Catfish Jupiter  |           31482.270723193219263320 |    0.000000000000000000 |           31482.270723193219263320 |    0.000000000000000000 |           31482.270723193219263320 |         N/A |                    |
| zksync   | 0x8E86e46278518EFc1C5CEd245cBA2C7e3ef11557 | USD+             |                          43.206787 |                4.630490 |                          38.576297 |                2.156456 |                          36.419841 |       36.09 |                    |