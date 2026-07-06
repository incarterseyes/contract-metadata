import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js'
import ajvFormats from 'ajv-formats'

// ajv-formats is CJS; under NodeNext the callable plugin is the module's
// `default` export (which self-references at runtime, so this works under
// both node and tsx interop).
const addFormats = ajvFormats.default
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, basename } from 'node:path'
import { semanticChecks, type ValidatableDocument } from '@evmnow/sdk/validate'
import { merge } from '@evmnow/sdk/merge'

// Schema validation runs against the local schema files; the semantic checks
// (cross-references, input flags, key formats, variant ambiguity) are the
// SDK's canonical implementation — see @evmnow/sdk/validate. Includes are
// resolved locally (schema/interfaces/*.json) and merged with the SDK's
// canonical merge before semantic checks run, so cross-references into
// included interfaces resolve exactly as they do for consumers.

const CONTRACT_SCHEMA_URL = 'https://evmnow.github.io/contract-metadata/v1/schema.json'
const INTERFACE_SCHEMA_URL = 'https://evmnow.github.io/contract-metadata/v1/interface.schema.json'

const POSITIONAL_KEY = /^_\d+$/

type Rec = Record<string, unknown>

interface MetaDoc {
  $schema?: string
  chainId?: number
  address?: string
  includes?: string[]
  groups?: Record<string, Rec>
  actions?: Record<string, Rec>
  events?: Record<string, Rec>
  errors?: Record<string, Rec>
  [key: string]: unknown
}

const mergeDocs = merge as unknown as (...layers: (MetaDoc | null | undefined)[]) => MetaDoc

// ---------------------------------------------------------------------------
// CLI

const USAGE = `Usage: tsx validate.ts [--contracts] [--interfaces] [--examples] [--no-strict]

Validates metadata documents against the JSON Schemas and the SDK's semantic
checks. With no selection flags, all file sets are validated.

  --contracts    validate contracts/{chainId}/{address}.json
  --interfaces   validate schema/interfaces/*.json
  --examples     validate examples/*.json
  --no-strict    downgrade semantic issues to warnings (schema violations,
                 malformed JSON, and layout errors still fail)
`

const KNOWN_FLAGS = new Set(['--contracts', '--interfaces', '--examples', '--no-strict'])
const args = process.argv.slice(2)
const unknown = args.filter(a => !KNOWN_FLAGS.has(a))
if (unknown.length > 0) {
  console.error(`Unknown option(s): ${unknown.join(', ')}\n`)
  console.error(USAGE)
  process.exit(2)
}

const strict = !args.includes('--no-strict')
const selections = args.filter(a => a !== '--no-strict')
const runContracts = selections.length === 0 || selections.includes('--contracts')
const runInterfaces = selections.length === 0 || selections.includes('--interfaces')
const runExamples = selections.length === 0 || selections.includes('--examples')

// ---------------------------------------------------------------------------
// Schemas

const ajv = new Ajv2020({ strict: true, allErrors: true })
addFormats(ajv)

const contractSchema = JSON.parse(readFileSync('schema/contract-metadata.schema.json', 'utf8')) as Rec
const interfaceSchema = JSON.parse(readFileSync('schema/interface.schema.json', 'utf8')) as Rec
const componentSchema = JSON.parse(readFileSync('extensions/_component.schema.json', 'utf8')) as Rec

ajv.addSchema(contractSchema)
const validateContract = ajv.compile(contractSchema)
const validateInterface = ajv.compile(interfaceSchema)
const validateComponent = ajv.compile(componentSchema)

// ---------------------------------------------------------------------------
// Interface resolution (local, offline)

const INTERFACE_DIR = join('schema', 'interfaces')

const interfaceExists = (name: string) => existsSync(join(INTERFACE_DIR, `${name}.json`))

function readInterface(name: string): MetaDoc | null {
  const path = join(INTERFACE_DIR, `${name}.json`)
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, 'utf8')) as MetaDoc
}

/**
 * Expand an interface document's own `includes` (interface files MAY compose)
 * into a single merged layer. Cycles are reported and broken.
 */
function expandInterface(doc: MetaDoc, stack: string[], issues: string[]): MetaDoc {
  const layers: MetaDoc[] = []
  for (const ref of doc.includes ?? []) {
    if (!ref.startsWith('interface:')) continue // https URL includes are not fetched offline
    const name = ref.slice('interface:'.length)
    if (stack.includes(name)) {
      issues.push(`include cycle detected: ${[...stack, name].join(' -> ')}`)
      continue
    }
    const included = readInterface(name)
    if (!included) continue // unknown interface — reported by semanticChecks
    layers.push(expandInterface(included, [...stack, name], issues))
  }
  if (layers.length === 0) return doc
  return mergeDocs(...layers, doc)
}

/** Resolve a document's interface includes into a single interface layer. */
function resolveInterfaceLayer(doc: MetaDoc, issues: string[]): MetaDoc {
  const layers: MetaDoc[] = []
  for (const ref of doc.includes ?? []) {
    if (!ref.startsWith('interface:')) continue
    const name = ref.slice('interface:'.length)
    const included = readInterface(name)
    if (!included) continue // unknown interface — reported by semanticChecks
    layers.push(expandInterface(included, [name], issues))
  }
  return mergeDocs(...layers)
}

// ---------------------------------------------------------------------------
// Lints

/** Fields an override silently drops when it doesn't re-declare them (shallow merge). */
const OVERRIDE_FIELDS = ['title', 'params', 'returns', 'warning', 'stateMutability', 'related'] as const

/**
 * Post-merge completeness lint: when a contract overrides an action provided
 * by an included interface, the whole action object replaces the interface's
 * (shallow merge). Flag overrides that drop fields the interface version had.
 */
function completenessIssues(doc: MetaDoc, interfaceLayer: MetaDoc): string[] {
  const issues: string[] = []
  if (!doc.actions || !interfaceLayer.actions) return issues
  for (const [id, own] of Object.entries(doc.actions)) {
    const inherited = interfaceLayer.actions[id]
    if (!inherited) continue
    const dropped = OVERRIDE_FIELDS.filter(f => inherited[f] !== undefined && own[f] === undefined)
    if (dropped.length > 0) {
      issues.push(
        `actions.${id} overrides an interface action but drops ${dropped.map(f => `"${f}"`).join(', ')} — ` +
        `shallow merge replaces the whole action; re-declare every field you want to keep`,
      )
    }
  }
  return issues
}

/** Interface files MUST use positional keys (_0, _1, ...) for params/returns. */
function positionalKeyIssues(doc: MetaDoc): string[] {
  const issues: string[] = []
  const check = (table: Rec | undefined, where: string) => {
    for (const key of Object.keys(table ?? {})) {
      if (!POSITIONAL_KEY.test(key)) {
        issues.push(`${where} uses key "${key}" — interface files must use positional keys (_0, _1, ...)`)
      }
    }
  }
  for (const [id, action] of Object.entries(doc.actions ?? {})) {
    check(action.params as Rec | undefined, `actions.${id}.params`)
    check(action.returns as Rec | undefined, `actions.${id}.returns`)
  }
  for (const [section, table] of [['events', doc.events], ['errors', doc.errors]] as const) {
    for (const [key, entry] of Object.entries(table ?? {})) {
      check(entry.params as Rec | undefined, `${section}.${key}.params`)
    }
  }
  return issues
}

/** Validate every `_component` extension occurrence against its schema. */
function componentIssues(node: unknown, path: string, issues: string[]): void {
  if (Array.isArray(node)) {
    node.forEach((item, i) => componentIssues(item, `${path}[${i}]`, issues))
    return
  }
  if (node === null || typeof node !== 'object') return
  for (const [key, value] of Object.entries(node as Rec)) {
    const at = path ? `${path}.${key}` : key
    if (key === '_component') {
      if (!validateComponent(value)) {
        for (const err of validateComponent.errors as ErrorObject[]) {
          issues.push(`${at}${err.instancePath} ${err.message} (extensions/_component.schema.json)`)
        }
      }
      continue
    }
    componentIssues(value, at, issues)
  }
}

// ---------------------------------------------------------------------------
// File checking

let checkedFiles = 0
let failedFiles = 0
let warningCount = 0

function report(path: string, errors: string[], warnings: string[]): void {
  if (errors.length === 0 && warnings.length === 0) {
    console.log(`  \x1b[32m✓\x1b[0m ${path}`)
  } else if (errors.length === 0) {
    console.log(`  \x1b[33m⚠\x1b[0m ${path}`)
  } else {
    failedFiles++
    console.log(`  \x1b[31m✗\x1b[0m ${path}`)
  }
  for (const e of errors) console.log(`      \x1b[31merror\x1b[0m ${e}`)
  for (const w of warnings) console.log(`      \x1b[33mwarn\x1b[0m  ${w}`)
  warningCount += warnings.length
}

function parseFile(path: string): { doc: MetaDoc | null; error: string | null } {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    return { doc: null, error: `cannot read file: ${(err as Error).message}` }
  }
  try {
    return { doc: JSON.parse(raw) as MetaDoc, error: null }
  } catch (err) {
    return { doc: null, error: `invalid JSON: ${(err as Error).message}` }
  }
}

function schemaErrors(validate: ValidateFunction, doc: MetaDoc): string[] {
  if (validate(doc)) return []
  return (validate.errors as ErrorObject[]).map(err => `${err.instancePath || '/'} ${err.message}`)
}

/** Validate a contract metadata document (contracts/ and examples/). */
function checkContractFile(path: string, options: { expectedChainDir?: string }): void {
  checkedFiles++
  const errors: string[] = []
  const warnings: string[] = []
  const semantic = strict ? errors : warnings

  const { doc, error } = parseFile(path)
  if (!doc) {
    report(path, [error as string], [])
    return
  }

  errors.push(...schemaErrors(validateContract, doc))

  if (doc.$schema !== CONTRACT_SCHEMA_URL) {
    errors.push(`$schema must be "${CONTRACT_SCHEMA_URL}", got "${doc.$schema}"`)
  }

  const expectedAddress = basename(path, '.json')
  if (doc.address !== expectedAddress) {
    errors.push(`filename "${expectedAddress}" does not match address "${doc.address}"`)
  }
  if (options.expectedChainDir !== undefined && String(doc.chainId) !== options.expectedChainDir) {
    errors.push(`directory "contracts/${options.expectedChainDir}/" does not match chainId ${doc.chainId}`)
  }

  const interfaceLayer = resolveInterfaceLayer(doc, semantic)
  const merged = mergeDocs(interfaceLayer, doc)

  for (const issue of semanticChecks(merged as unknown as ValidatableDocument, { interfaceExists })) {
    semantic.push(issue.message)
  }
  semantic.push(...completenessIssues(doc, interfaceLayer))
  componentIssues(doc, '', errors)

  report(path, errors, warnings)
}

/** Validate an interface metadata file (schema/interfaces/). */
function checkInterfaceFile(path: string): void {
  checkedFiles++
  const errors: string[] = []
  const warnings: string[] = []
  const semantic = strict ? errors : warnings

  const { doc, error } = parseFile(path)
  if (!doc) {
    report(path, [error as string], [])
    return
  }

  errors.push(...schemaErrors(validateInterface, doc))

  if (doc.$schema !== INTERFACE_SCHEMA_URL) {
    errors.push(`$schema must be "${INTERFACE_SCHEMA_URL}", got "${doc.$schema}"`)
  }

  errors.push(...positionalKeyIssues(doc))

  const name = basename(path, '.json')
  const merged = expandInterface(doc, [name], semantic)
  for (const issue of semanticChecks(merged as unknown as ValidatableDocument, { interfaceExists })) {
    semantic.push(issue.message)
  }
  componentIssues(doc, '', errors)

  report(path, errors, warnings)
}

// ---------------------------------------------------------------------------
// File discovery

if (runContracts && existsSync('contracts')) {
  console.log('contracts/')
  for (const entry of readdirSync('contracts', { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.json')) {
      checkedFiles++
      report(join('contracts', entry.name), [
        'file is not in the contracts/{chainId}/{address}.json layout',
      ], [])
      continue
    }
    if (!entry.isDirectory()) continue
    const chainDir = entry.name
    if (!/^\d+$/.test(chainDir)) {
      checkedFiles++
      report(join('contracts', chainDir), [`directory name must be a chain id, got "${chainDir}"`], [])
      continue
    }
    const dirPath = join('contracts', chainDir)
    for (const file of readdirSync(dirPath).filter(f => f.endsWith('.json')).sort()) {
      checkContractFile(join(dirPath, file), { expectedChainDir: chainDir })
    }
  }
}

if (runInterfaces && existsSync(INTERFACE_DIR)) {
  console.log('schema/interfaces/')
  for (const file of readdirSync(INTERFACE_DIR).filter(f => f.endsWith('.json')).sort()) {
    checkInterfaceFile(join(INTERFACE_DIR, file))
  }
}

if (runExamples && existsSync('examples')) {
  console.log('examples/')
  for (const file of readdirSync('examples').filter(f => f.endsWith('.json')).sort()) {
    checkContractFile(join('examples', file), {})
  }
}

// ---------------------------------------------------------------------------
// Summary

console.log()
if (checkedFiles === 0) {
  console.log('\x1b[31mNo files were checked.\x1b[0m')
  process.exit(1)
}

const summary = `Checked ${checkedFiles} file${checkedFiles === 1 ? '' : 's'}` +
  (warningCount > 0 ? `, ${warningCount} warning${warningCount === 1 ? '' : 's'}` : '')

if (failedFiles > 0) {
  console.log(`${summary}.`)
  console.log(`\x1b[31mValidation failed (${failedFiles} file${failedFiles === 1 ? '' : 's'} with errors).\x1b[0m`)
  process.exit(1)
}

console.log(`${summary}.`)
console.log('\x1b[32mAll files valid.\x1b[0m')
