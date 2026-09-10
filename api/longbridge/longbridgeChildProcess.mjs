export function writeChildResult(payload, exitCode = 0) {
  process.stdout.write(JSON.stringify(payload), () => process.exit(exitCode))
}
