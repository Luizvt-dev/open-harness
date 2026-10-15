import { bashTool } from '@open-harness/dsh-tool-bash'
import { fsTools } from '@open-harness/dsh-tool-fs'
import { searchTools } from '@open-harness/dsh-tool-fs-search'
import type { ToolDefinition } from '@open-harness/dsh-tools'

/**
 * Conjunto de tools por omissão da CLI `dsh`: filesystem, procura e shell.
 * É o que o modo headless regista no `ToolRegistry` do agente.
 */
export function defaultCliTools(): ToolDefinition[] {
  return [...fsTools(), ...searchTools(), bashTool()]
}

/** Nomes das tools por omissão, para asserções/ajuda. */
export const DEFAULT_CLI_TOOL_NAMES: readonly string[] = ['read', 'write', 'edit', 'glob', 'grep', 'bash']
