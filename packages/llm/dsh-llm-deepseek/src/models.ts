// ---------------------------------------------------------------------------
// Catálogo de modelos (advisory — o provider pode aceitar outros IDs)
// ---------------------------------------------------------------------------

export interface DeepSeekModelInfo {
  /** ID enviado na API. */
  id: string
  /** Nome legível (UI). */
  label: string
  /** Janela de contexto em tokens. */
  contextWindow: number
  /** Aceita anexos de imagem. */
  vision: boolean
}

/** Defaults observados no dsh. */
export const DEEPSEEK_DEFAULT_CONTEXT_WINDOW = 1_000_000
export const DEEPSEEK_DEFAULT_MAX_TOKENS = 256_000

/** Catálogo advisory dos modelos DeepSeek observados no dsh. */
export const DEEPSEEK_MODELS: readonly DeepSeekModelInfo[] = Object.freeze([
  {
    id: 'deepseek-flash',
    label: 'DeepSeek-V41-Flash',
    contextWindow: DEEPSEEK_DEFAULT_CONTEXT_WINDOW,
    vision: true,
  },
  {
    id: 'deepseek-v4-pro',
    label: 'DeepSeek-V4-Pro',
    contextWindow: DEEPSEEK_DEFAULT_CONTEXT_WINDOW,
    vision: false,
  },
])

const byId = new Map(DEEPSEEK_MODELS.map((model) => [model.id, model]))

/** Modelo por ID; `null` se não estiver no catálogo. */
export function getModel(id: string): DeepSeekModelInfo | null {
  return byId.get(id) ?? null
}

/** Modelo por ID; lança se desconhecido (quando o caller exige conhecido). */
export function requireModel(id: string): DeepSeekModelInfo {
  const model = byId.get(id)
  if (!model) throw new Error(`unknown DeepSeek model "${id}" (known: ${[...byId.keys()].join(', ')})`)
  return model
}
