import Ajv, { type ErrorObject } from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { readFileSync, readdirSync, existsSync } from 'fs'
import { join, basename } from 'path'
import { semanticChecks, type ValidatableDocument } from '@evmnow/sdk/validate'

// Schema validation runs against the local schema files; the semantic checks
// (cross-references, input flags, key formats, variant ambiguity) are the
// SDK's canonical implementation — see @evmnow/sdk/validate.

const ajv = new Ajv({ strict: false, allErrors: true })
addFormats(ajv)

const contractSchema = JSON.parse(readFileSync('schema/contract-metadata.schema.json', 'utf8'))
const interfaceSchema = JSON.parse(readFileSync('schema/interface.schema.json', 'utf8'))

ajv.addSchema(contractSchema, 'contract-metadata.schema.json')
const validateContract = ajv.compile(contractSchema)
const validateInterface = ajv.compile(interfaceSchema)

const interfaceExists = (name: string) =>
  existsSync(join('schema', 'interfaces', `${name}.json`))

const args = process.argv.slice(2)
const runContracts = args.length === 0 || args.includes('--contracts')
const runInterfaces = args.length === 0 || args.includes('--interfaces')

let hasErrors = false

function checkFile(
  path: string,
  validate: typeof validateContract,
  options: { expectedAddress?: string },
) {
  const data = JSON.parse(readFileSync(path, 'utf8')) as ValidatableDocument
  const valid = validate(data)

  if (valid) {
    console.log(`  \x1b[32m✓\x1b[0m ${path}`)
  } else {
    hasErrors = true
    console.log(`  \x1b[31m✗\x1b[0m ${path}`)
    for (const err of validate.errors as ErrorObject[]) {
      console.log(`    ${err.instancePath || '/'} ${err.message}`)
    }
  }

  const issues = semanticChecks(data, { ...options, interfaceExists })
  for (const issue of issues) {
    console.log(`    \x1b[33m⚠\x1b[0m ${issue.message}`)
  }
}

if (runContracts && existsSync('contracts')) {
  const contractDir = 'contracts'
  const files = readdirSync(contractDir).filter(f => f.endsWith('.json'))

  for (const file of files) {
    const path = join(contractDir, file)
    checkFile(path, validateContract, { expectedAddress: basename(file, '.json') })
  }
}

if (runInterfaces && existsSync('schema/interfaces')) {
  const interfaceDir = 'schema/interfaces'
  const files = readdirSync(interfaceDir).filter(f => f.endsWith('.json'))

  for (const file of files) {
    const path = join(interfaceDir, file)
    checkFile(path, validateInterface, {})
  }
}

if (hasErrors) {
  console.log('\n\x1b[31mValidation failed.\x1b[0m')
  process.exit(1)
} else {
  console.log('\n\x1b[32mAll files valid.\x1b[0m')
}
