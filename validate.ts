import Ajv, { type ErrorObject } from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { readFileSync, readdirSync, existsSync } from 'fs'
import { join, basename } from 'path'

interface ContractData {
  address?: string
  includes?: string[]
  groups?: Record<string, unknown>
  actions?: Record<string, ActionEntry>
  events?: Record<string, unknown>
  errors?: Record<string, unknown>
}

interface ActionEntry {
  function?: string
  group?: string
  related?: string[]
  params?: Record<string, ParamEntry>
  value?: ParamEntry
}

interface ParamEntry {
  autofill?: unknown
  hidden?: boolean
  disabled?: boolean
}

const ajv = new Ajv({ strict: false, allErrors: true })
addFormats(ajv)

const contractSchema = JSON.parse(readFileSync('schema/contract-metadata.schema.json', 'utf8'))
const interfaceSchema = JSON.parse(readFileSync('schema/interface.schema.json', 'utf8'))

ajv.addSchema(contractSchema, 'contract-metadata.schema.json')
const validateContract = ajv.compile(contractSchema)
const validateInterface = ajv.compile(interfaceSchema)

// Valid key formats
const SELECTOR_4BYTE = /^0x[0-9a-f]{8}$/
const SELECTOR_32BYTE = /^0x[0-9a-f]{64}$/
const SIGNATURE_RE = /^[a-zA-Z_][a-zA-Z0-9_]*\(.*\)$/
const BARE_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/
const ACTION_ID_RE = /^[a-zA-Z_][a-zA-Z0-9_-]*$/

const args = process.argv.slice(2)
const runContracts = args.length === 0 || args.includes('--contracts')
const runInterfaces = args.length === 0 || args.includes('--interfaces')

let hasErrors = false

if (runContracts && existsSync('contracts')) {
  const contractDir = 'contracts'
  const files = readdirSync(contractDir).filter(f => f.endsWith('.json'))

  for (const file of files) {
    const path = join(contractDir, file)
    const data: ContractData = JSON.parse(readFileSync(path, 'utf8'))
    const valid = validateContract(data)

    if (valid) {
      console.log(`  \x1b[32m✓\x1b[0m ${path}`)
    } else {
      hasErrors = true
      console.log(`  \x1b[31m✗\x1b[0m ${path}`)
      for (const err of validateContract.errors as ErrorObject[]) {
        console.log(`    ${err.instancePath || '/'} ${err.message}`)
      }
    }

    const warnings = semanticChecks(data, path)
    for (const w of warnings) {
      console.log(`    \x1b[33m⚠\x1b[0m ${w}`)
    }
  }
}

if (runInterfaces && existsSync('schema/interfaces')) {
  const interfaceDir = 'schema/interfaces'
  const files = readdirSync(interfaceDir).filter(f => f.endsWith('.json'))

  for (const file of files) {
    const path = join(interfaceDir, file)
    const data: ContractData = JSON.parse(readFileSync(path, 'utf8'))
    const valid = validateInterface(data)

    if (valid) {
      console.log(`  \x1b[32m✓\x1b[0m ${path}`)
    } else {
      hasErrors = true
      console.log(`  \x1b[31m✗\x1b[0m ${path}`)
      for (const err of validateInterface.errors as ErrorObject[]) {
        console.log(`    ${err.instancePath || '/'} ${err.message}`)
      }
    }

    const warnings = semanticChecks(data, path)
    for (const w of warnings) {
      console.log(`    \x1b[33m⚠\x1b[0m ${w}`)
    }
  }
}

if (hasErrors) {
  console.log('\n\x1b[31mValidation failed.\x1b[0m')
  process.exit(1)
} else {
  console.log('\n\x1b[32mAll files valid.\x1b[0m')
}

function isValidFunctionRef(ref: string): boolean {
  return SELECTOR_4BYTE.test(ref) || SIGNATURE_RE.test(ref) || BARE_NAME_RE.test(ref)
}

function inputFlagChecks(p: ParamEntry, where: string): string[] {
  const warnings: string[] = []
  if (p.hidden && p.autofill === undefined) {
    warnings.push(`${where}.hidden requires autofill`)
  }
  if (p.disabled && p.autofill === undefined) {
    warnings.push(`${where}.disabled requires autofill`)
  }
  if (p.hidden && p.disabled) {
    warnings.push(`${where}.hidden and .disabled are mutually exclusive`)
  }
  return warnings
}

// The symbolic constraint a locked (hidden/disabled) param contributes to
// calldata matching, or null if the autofill can't be matched against
// (block-timestamp) or the param isn't locked.
function lockedConstraint(p: ParamEntry): string | null {
  if (!p.hidden && !p.disabled) return null
  const a = p.autofill
  if (typeof a === 'string') {
    return a === 'block-timestamp' ? null : a
  }
  if (a && typeof a === 'object' && (a as { type?: string }).type === 'constant') {
    return `constant:${(a as { value?: string }).value}`
  }
  return null
}

// Two actions on the same function with identical locked constraints can't be
// told apart when matching decoded calldata — flag them.
function ambiguityChecks(actions: Record<string, ActionEntry>): string[] {
  const warnings: string[] = []
  const seen = new Map<string, string>()
  for (const [id, action] of Object.entries(actions)) {
    const fn = action.function ?? id
    const locks = Object.entries(action.params ?? {})
      .map(([pKey, p]) => [pKey, lockedConstraint(p)] as const)
      .filter(([, c]) => c !== null)
      .map(([pKey, c]) => `${pKey}=${c}`)
      .sort()
    if (action.value) {
      const c = lockedConstraint(action.value)
      if (c !== null) locks.push(`msg.value=${c}`)
    }
    const key = `${fn}|${locks.join(',')}`
    const prior = seen.get(key)
    if (prior !== undefined) {
      warnings.push(`actions.${id} and actions.${prior} target "${fn}" with identical locked parameters — calldata matching cannot distinguish them`)
    } else {
      seen.set(key, id)
    }
  }
  return warnings
}

function semanticChecks(data: ContractData, path: string): string[] {
  const warnings: string[] = []
  const groups = data.groups ? Object.keys(data.groups) : []

  if (data.actions) {
    const actionIds = new Set(Object.keys(data.actions))
    for (const [id, action] of Object.entries(data.actions)) {
      if (!ACTION_ID_RE.test(id)) {
        warnings.push(`actions key "${id}" is not a valid action id (must match ${ACTION_ID_RE})`)
      }

      if (action.function !== undefined) {
        if (!isValidFunctionRef(action.function)) {
          warnings.push(`actions.${id}.function "${action.function}" is not a valid name, signature, or 4-byte selector`)
        }
      } else if (!BARE_NAME_RE.test(id)) {
        // No explicit `function` — id is used as the fallback reference, so it
        // must itself be a valid bare function name (variants with hyphens etc.
        // need an explicit `function`).
        warnings.push(`actions.${id}: no "function" set, and id "${id}" is not a valid bare function name — set \`function\` explicitly`)
      }

      if (action.group && groups.length > 0 && !groups.includes(action.group)) {
        warnings.push(`actions.${id}.group "${action.group}" not found in groups`)
      }

      if (action.related) {
        for (const ref of action.related) {
          if (!actionIds.has(ref)) {
            warnings.push(`actions.${id}.related references unknown action "${ref}"`)
          }
        }
      }

      if (action.params) {
        for (const [pKey, p] of Object.entries(action.params)) {
          warnings.push(...inputFlagChecks(p, `actions.${id}.params.${pKey}`))
        }
      }

      if (action.value) {
        warnings.push(...inputFlagChecks(action.value, `actions.${id}.value`))
      }
    }

    warnings.push(...ambiguityChecks(data.actions))
  }

  if (data.events) {
    for (const key of Object.keys(data.events)) {
      if (!SELECTOR_32BYTE.test(key) && !SIGNATURE_RE.test(key) && /[^a-zA-Z0-9_]/.test(key)) {
        warnings.push(`events key "${key}" is not a valid name, signature, or 32-byte topic hash`)
      }
    }
  }

  if (data.errors) {
    for (const key of Object.keys(data.errors)) {
      if (!SELECTOR_4BYTE.test(key) && !SIGNATURE_RE.test(key) && /[^a-zA-Z0-9_]/.test(key)) {
        warnings.push(`errors key "${key}" is not a valid name, signature, or 4-byte selector`)
      }
    }
  }

  if (data.includes) {
    for (const ref of data.includes) {
      if (ref.startsWith('interface:')) {
        const name = ref.slice('interface:'.length)
        if (!existsSync(join('schema', 'interfaces', `${name}.json`))) {
          warnings.push(`includes references unknown interface "${ref}"`)
        }
      }
    }
  }

  if (data.address) {
    const expected = basename(path, '.json')
    if (data.address !== expected) {
      warnings.push(`address "${data.address}" does not match filename "${expected}"`)
    }
  }

  return warnings
}
