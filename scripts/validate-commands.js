const { COMMANDS } = require('../core/commands/command-data.ts')
const { BIN_COMMANDS_SET, REGISTERED_VERBS_SET } = require('../core/commands/verb-names.ts')
const { REMOVED_VERBS } = require('../core/commands/removed-verbs.ts')

const removedLowValue = ['suggest', 'git', 'test', 'migrate']
const errors = []

function fail(message) {
  errors.push(message)
}

const seen = new Set()
for (const command of COMMANDS) {
  if (seen.has(command.name)) fail(`Duplicate command name: ${command.name}`)
  seen.add(command.name)

  if (removedLowValue.includes(command.name)) {
    fail(`Removed low-value command is still advertised: ${command.name}`)
  }

  if (REMOVED_VERBS[command.name]) {
    fail(`Removed v2 verb is still advertised: ${command.name}`)
  }

  if (!command.routing && command.routingMode !== 'bin-only') {
    fail(`Command has no routing contract: ${command.name}`)
  }

  if (command.usage?.claude && !command.usage.claude.startsWith('p. ')) {
    fail(`Agent usage must start with p.: ${command.name} -> ${command.usage.claude}`)
  }

  if (command.usage?.claude?.includes('/')) {
    fail(`Agent usage advertises stale slash command: ${command.name} -> ${command.usage.claude}`)
  }

  if (command.routingMode === 'bin-only') {
    if (!BIN_COMMANDS_SET.has(command.name))
      fail(`bin-only command missing from BIN_COMMANDS_SET: ${command.name}`)
  } else if (!REGISTERED_VERBS_SET.has(command.name)) {
    fail(`routed command missing from REGISTERED_VERBS_SET: ${command.name}`)
  }
}

for (const verb of Object.keys(REMOVED_VERBS)) {
  if (REGISTERED_VERBS_SET.has(verb) || BIN_COMMANDS_SET.has(verb)) {
    fail(`Removed verb is still routable: ${verb}`)
  }
}

const groups = COMMANDS.reduce((acc, command) => {
  acc[command.group] = (acc[command.group] || 0) + 1
  return acc
}, {})

console.log('Command registry validation')
console.log(`commands: ${COMMANDS.length}`)
console.log(
  `groups: ${Object.entries(groups)
    .map(([group, count]) => `${group}:${count}`)
    .join(', ')}`
)

if (errors.length > 0) {
  console.error('\nValidation failed:')
  for (const error of errors) console.error(`- ${error}`)
  process.exit(1)
}

console.log('ok')
