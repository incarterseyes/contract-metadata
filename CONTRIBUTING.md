# Contributing

## Adding a contract file

1. Create the file at `contracts/{chainId}/{address}.json`:
   - The directory is the decimal chain ID (`1` for Ethereum mainnet).
   - The filename is the contract address, **lowercase**, no checksum — the validator rejects files whose name doesn't match the `address` field or whose directory doesn't match `chainId`.
2. Set the header fields:
   - `$schema` MUST be exactly `https://evmnow.github.io/contract-metadata/v1/schema.json`.
   - `chainId` and `address` are required; `address` must be lowercase hex.
3. Keep every `description` (contract, action, event, error, message, group, parameter) to a single plain-language sentence of **at most 120 characters**. Long-form context belongs in the contract-level `about` field (Markdown, no length limit).
4. Do not invent data. Only add `audits`, `links`, `risks`, etc. that are real and verifiable. Fictional/showcase documents belong in `examples/`.
5. Run the validator (see below) until it passes with zero errors.

## The shallow-merge override checklist

Includes are merged **shallowly per action key**: if your contract file declares an action that an included interface also provides, your object **replaces** the interface's object entirely — nothing is inherited field-by-field.

When you override an interface action (e.g. `approve` from `interface:erc20`):

- [ ] Re-declare `title` if the interface had one.
- [ ] Re-declare `params` (all of them, not just the ones you change).
- [ ] Re-declare `returns`.
- [ ] Re-declare `warning` (dropping a risk warning silently is the worst case).
- [ ] Re-declare `stateMutability` if the interface set it.
- [ ] Re-declare `related`.
- [ ] Re-declare `group` (and `intent`) if you want the action to stay grouped.

The validator enforces this: an override that drops `title`, `params`, `returns`, `warning`, `stateMutability`, or `related` compared to the interface version fails strict validation.

## Interface files (`schema/interfaces/`)

Interface files describe *every* implementation of a standard, so:

- `$schema` MUST be exactly `https://evmnow.github.io/contract-metadata/v1/interface.schema.json`.
- `params` and `returns` keys MUST be positional (`_0`, `_1`, ...) — parameter names are not part of a function's interface (`approve(address,uint256)` is the same function whether the parameters are named `spender`/`amount` or `guy`/`wad`). This is a MUST in the spec and enforced by the validator.
- Declare `interfaceId` (the ERC-165 identifier, e.g. `0x36372b07` for ERC-20) so consumers can auto-detect the interface via `supportsInterface()`.
- Interface files MAY declare `includes` to compose other interfaces; the same merge semantics apply and cycles are rejected.
- Keep files small and single-purpose: ERC-721 core, metadata, and enumerable extensions are separate files (`erc721.json`, `erc721-metadata.json`, `erc721-enumerable.json`) so contracts only include what they implement.

## Extensions (`extensions/`)

Extension fields start with `_` followed by a letter (e.g. `_component`). To document a well-known extension:

1. Add `extensions/<name>.md` describing the extension's purpose and shape.
2. Add `extensions/<name>.schema.json` — a JSON Schema for the extension's value. The pair is the convention: every documented extension has both files.
3. If the validator should enforce it, wire it up in `validate.ts` (see the `_component` handling).

Consumers that do not understand an extension MUST ignore it.

## Running validation

```bash
pnpm install
pnpm validate              # everything: contracts/, schema/interfaces/, examples/
pnpm validate:contracts    # only contracts/
pnpm validate:interfaces   # only schema/interfaces/
pnpm validate:examples     # only examples/
pnpm typecheck             # typecheck validate.ts
```

Validation is strict by default: schema violations, layout errors, semantic issues (unknown groups, dangling `related` references, `hidden` without `autofill`, ambiguous variants), and shallow-merge completeness all fail the run. `--no-strict` downgrades the semantic class to warnings if you need a partial report while iterating, but CI runs strict.
