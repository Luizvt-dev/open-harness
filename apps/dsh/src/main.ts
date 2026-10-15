#!/usr/bin/env node
import { exitCodeFor, runCli } from './cli.js'

// Um único `AbortController` para a vida do processo: o SIGINT cancela o turno
// em curso (o `AgentLoop` propaga o sinal ao request LLM e às tools).
const controller = new AbortController()
process.once('SIGINT', () => controller.abort())

try {
  process.exitCode = await runCli(process.argv.slice(2), { signal: controller.signal })
} catch (error) {
  console.error(`dsh: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = exitCodeFor(error)
}
