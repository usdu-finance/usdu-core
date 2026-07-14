# Deprecated Modules

Registry of USDU minting modules that have been retired. All entries below are marked
`// set to expire, deprecated` in `exports/address.config.ts` and were confirmed on-chain
against `usduStable.modules(address)` / `checkValidModule(address)` on mainnet
(`0xdde3eC717f220Fc6A29D6a4Be73F91DA5b718e55`).

Once a module's `expiredAt` timestamp passes, `checkValidModule` returns `false` and the
module can no longer mint (`mintModule`) or bypass burn allowance — it can still be
inspected but is no longer an active minter. Addresses stay in `address.config.ts` for
historical reference until fully swept.

## Morpho adapters

| Name | Address | Expiry (UTC) | Minted at last check | Assets at last check | Lifetime revenue |
|---|---|---|---|---|---|
| `usduMorphoAdapterV1` | `0x6D6525D8e234D840b2699f7107f14fa0D6C62c42` | 2025-08-30 20:00 | 0 | 0 | 0.00229 USDU |
| `usduMorphoAdapterV1_1` | `0xab6523Cd7fa669EC35Bd5358dF505382b810CDB5` | 2025-09-30 15:58 | 0 | 0 | 0.00184 USDU |
| `usduMorphoAdapterV1_2` | `0xFb46481A9819e068Af0EB64a2C2824FCecAAAA45` | 2026-07-30 10:00 (proposed, unix `1785405600`) | 34,938.88 USDU | 34,938.88 USDU | 182.52 USDU |

`V1` and `V1_1` were already fully wound down (zero minted/assets) prior to deprecation.
`V1_2` was the active adapter (previously `type(uint192).max` expiry, i.e. non-expiring)
carrying ~34,939 USDU of outstanding minted debt at time of the clean-up decision —
redeem/reconcile this position down before or as part of expiry.

## Curve adapters

| Name | Address | Expiry (UTC) | Minted at last check | Lifetime revenue |
|---|---|---|---|---|
| `usduCurveAdapterV1_USDC` | `0x6f05782a28cDa7f01B054b014cF6cd92023937e4` | 2025-08-30 20:00 | 0 | 0 |
| `usduCurveAdapterV1_1_USDC` | `0x77eBb1D7a7f5371a61b7D21D7734b6dDE6F0f94F` | 2026-01-10 13:38 | 0 | 0 |
| `usduCurveAdapterV1_1_USDC_2` | `0x77cBb2f180F55dd2916bfC78F879A2C2dE37f638` | 2026-07-30 10:00 (proposed, unix `1785405600`; was 2027-10-17) | 22,682.83 USDU | 466.86 USDU |

`V1_USDC` and `V1_1_USDC` were already fully wound down. `V1_1_USDC_2` (deployed from the
`CurveAdapterV1_1` contract, second instance, pool `curveStableSwapNG_USDCUSDU`) was the
active adapter carrying ~22,683 USDU of outstanding minted debt — same wind-down caveat as
`usduMorphoAdapterV1_2` above.

## TermMax adapters

| Name | Address | Expiry (UTC) | Minted at last check | Lifetime revenue |
|---|---|---|---|---|
| `termmaxVaultAdapterRecoverV1_Core` | `0x8F36bbEe57aCB4857CB97898020B529969FDF221` | 2026-07-30 10:00 (proposed, unix `1785405600`; was 2027-10-09) | ~0 (dust: 5.12e-10 USDU) | 377.33 USDU |
| `termmaxVaultAdapterRecoverV1_RWA` | `0x397FB4A34757Ac180C0841b26131F25040e2E50B` | 2026-07-30 10:00 (proposed, unix `1785405600`; was 2027-10-09) | ~0 (dust: 1e-12 USDU) | 0.464 USDU |
| `termmaxVaultAdapterRecoverV1_Yield` | `0x5febEFD5AeCFefB3352c5Edd49d634B1456c4bD7` | 2026-07-30 10:00 (proposed, unix `1785405600`; was 2027-10-09) | 0 | 0 |

All three were already effectively idle (dust-level or zero outstanding debt) at time of
deprecation — no redemption needed before expiry.

## New expiry proposal

All previously-active modules (`usduMorphoAdapterV1_2`, `usduCurveAdapterV1_1_USDC_2`,
`termmaxVaultAdapterRecoverV1_Core`, `termmaxVaultAdapterRecoverV1_RWA`,
`termmaxVaultAdapterRecoverV1_Yield`) are proposed to expire at:

- Unix timestamp: `1785405600`
- UTC: 2026-07-30 10:00:00
- CEST: 2026-07-30 12:00:00

This is submitted via `setModule(module, 1785405600, message)` on `usduStable`, subject to
the curator timelock. Until the timelock elapses and `applyDistribution`/pending value is
confirmed, `checkValidModule` for these five will still return `true`. Positions carrying
outstanding minted debt (`usduMorphoAdapterV1_2` ~34,939 USDU,
`usduCurveAdapterV1_1_USDC_2` ~22,683 USDU) should be redeemed down before the expiry
timestamp so no debt is left stranded past validity.

## Verification snapshot

Checked against mainnet block `25,531,320` (chain time 2026-07-14 13:55:59 UTC). All three
groups' non-deprecated members previously returned `checkValidModule == true`; this doc
should be updated once the newly-expired entries pass `1785405600` and are re-confirmed as
`false`.
