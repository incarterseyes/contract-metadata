# Contract Metadata

Human-readable context for smart contracts.

Contract Metadata is a JSON standard that layers human-readable context on top of onchain data. It enriches smart contracts at every level -- contract descriptions, action titles and warnings, semantic type annotations, input guidance, and event/error enrichment -- giving wallets, explorers, and dApps the information they need to present contract interactions in terms users understand.

**[Read the full specification](./eip-draft.md)**

## Canonical URLs

The schemas and data files are published via GitHub Pages:

| Resource         | URL                                                                        |
| ---------------- | -------------------------------------------------------------------------- |
| Contract schema  | `https://evmnow.github.io/contract-metadata/v1/schema.json`                |
| Interface schema | `https://evmnow.github.io/contract-metadata/v1/interface.schema.json`      |
| Interface files  | `https://evmnow.github.io/contract-metadata/v1/interfaces/<name>.json`     |
| Data files       | `https://evmnow.github.io/contract-metadata/contracts/{chainId}/{address}.json` |

## Quick Example

A CryptoPunks function with no metadata vs. with Contract Metadata:

```
offerPunkForSaleToAddress(uint256, uint256, address)
```

```json
{
  "$schema": "https://evmnow.github.io/contract-metadata/v1/schema.json",
  "chainId": 1,
  "address": "0xb47e3cd837ddf8e4c57f05d70ab865de6e193bbb",
  "actions": {
    "offerPunkForSaleToAddress": {
      "title": "List Punk for Sale (Private)",
      "description": "List a punk for sale to a specific address only.",
      "warning": "This creates a binding offer. The buyer can purchase at any time.",
      "intent": "List Punk #{punkIndex} for sale at {minSalePriceInWei} to {toAddress}",
      "params": {
        "punkIndex": { "label": "Punk", "type": "token-id" },
        "minSalePriceInWei": { "label": "Price", "type": "eth" },
        "toAddress": { "label": "Buyer", "type": "address" }
      }
    }
  }
}
```

Actions decouple the user-facing UX surface from the ABI. One ABI function can back multiple actions (variants). For example, a single `approve` function can surface as `approve` (normal), `approve-max` (unlimited, amount locked), and `revoke` (amount locked to 0) — each with its own title, intent, and warning.

## Repository Structure

```
contracts/{chainId}/   Metadata files for deployed contracts, one file per address
schema/                JSON Schema definitions
schema/interfaces/     Reusable interface metadata (ERC-20, ERC-721, ...)
extensions/            Well-known extension conventions (each <name>.md pairs with <name>.schema.json)
examples/              Fictional, fully-featured example documents
validate.ts            Schema + semantic validation script
eip-draft.md           Full EIP specification
```

Data files live at `contracts/{chainId}/{address}.json` with a lowercase address — e.g. `contracts/1/0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2.json` for WETH on mainnet.

## Validation

```bash
pnpm install
pnpm validate
```

`pnpm validate` checks every file in `contracts/`, `schema/interfaces/`, and `examples/` against the JSON Schemas, resolves interface includes, and runs the SDK's semantic checks plus repository lints (layout, `$schema` URLs, shallow-merge override completeness, positional keys in interface files, `_component` extension shape). Subsets: `pnpm validate:contracts`, `pnpm validate:interfaces`, `pnpm validate:examples`. Typecheck the validator itself with `pnpm typecheck`.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for how to add a contract file, interface file rules, extension conventions, and the shallow-merge override checklist.

## Extensions

The metadata standard supports custom extensions (keys starting with `_`) on all renderable objects. The following well-known extensions are documented:

- [`_component`](./extensions/_component.md) — Register a custom UI component on a function, event, parameter, or other metadata object. Validated against [`extensions/_component.schema.json`](./extensions/_component.schema.json).

## Authors

- YGG ([@yougogirldoteth](https://github.com/yougogirldoteth))
- Jalil Sebastian Wahdatehagh ([@jwahdatehagh](https://github.com/jwahdatehagh))

## License

Copyright and related rights waived via [CC0](./LICENSE).
