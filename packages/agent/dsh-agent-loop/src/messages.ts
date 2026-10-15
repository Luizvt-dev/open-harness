import type { ContentBlock, LlmMessage, LlmResponse } from '@open-harness/dsh-llm'
import type { SessionContentBlock, SessionRecord } from '@open-harness/dsh-session-format'

/**
 * Converte blocos de sessão (registos `message`) em blocos LLM. Os blocos de
 * tool_use/tool_result são guardados como `{ type, ...rest }` na sessão, por
 * isso a passagem é estrutural.
 */
function toLlmBlocks(blocks: SessionContentBlock[] | undefined): ContentBlock[] {
  if (!blocks) return []
  return blocks.map((block) => {
    switch (block.type) {
      case 'text':
        return { type: 'text', text: String(block.text ?? '') }
      case 'tool_use':
        return { type: 'tool_use', id: String(block.id ?? ''), name: String(block.name ?? ''), input: block.input }
      case 'tool_result': {
        const content = block.content as ToolResultBlockContent | undefined
        return {
          type: 'tool_result',
          tool_use_id: String(block.tool_use_id ?? ''),
          content: content ?? '',
          ...(block.is_error ? { is_error: true } : {}),
        }
      }
      case 'image':
        return block as unknown as ContentBlock
      default:
        return { type: 'text', text: String((block as { text?: string }).text ?? '') }
    }
  })
}

type ToolResultBlockContent = Extract<ContentBlock, { type: 'tool_result' }>['content']

/**
 * Reconstrói as mensagens LLM a partir dos registos da sessão.
 *
 * - `message` → uma mensagem com o role gravado;
 * - `tool_use` → bloco `tool_use` na mensagem do assistente;
 * - `tool_result` → bloco `tool_result` numa mensagem do utilizador.
 *
 * Registos adjacentes do mesmo role são fundidos numa única mensagem, para
 * respeitar o formato alternado do wire (user/assistant/…).
 */
export function sessionToMessages(records: readonly SessionRecord[]): LlmMessage[] {
  const messages: LlmMessage[] = []
  const pushBlocks = (role: LlmMessage['role'], blocks: ContentBlock[]): void => {
    if (!blocks.length) return
    const last = messages.at(-1)
    if (last && last.role === role && Array.isArray(last.content)) {
      last.content.push(...blocks)
      return
    }
    messages.push({ role, content: blocks })
  }

  for (const record of records) {
    if (record.type === 'message') {
      const role = (record.role ?? 'user') === 'assistant' ? 'assistant' : 'user'
      pushBlocks(role, toLlmBlocks(record.content))
    } else if (record.type === 'tool_use') {
      pushBlocks('assistant', [
        { type: 'tool_use', id: String(record.toolUseId ?? ''), name: String(record.name ?? ''), input: record.input },
      ])
    } else if (record.type === 'tool_result') {
      pushBlocks('user', [
        {
          type: 'tool_result',
          tool_use_id: String(record.toolUseId ?? ''),
          content: stringifyOutput(record.output),
          ...(record.isError ? { is_error: true } : {}),
        },
      ])
    }
    // summary/checkpoint/system não participam do wire
  }
  return messages
}

function stringifyOutput(output: unknown): string {
  if (typeof output === 'string') return output
  if (output === undefined) return ''
  try {
    return JSON.stringify(output)
  } catch {
    return String(output)
  }
}

/** Extrai o texto final (blocos `text` do assistente) de uma resposta. */
export function responseText(response: LlmResponse): string {
  return response.content
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('')
}
