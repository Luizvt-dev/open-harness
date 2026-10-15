import { addUsage, EMPTY_USAGE, type LlmUsage } from './types.js'

/**
 * Estimativa de tokens de texto — heurística (~4 chars/token em inglês/código).
 * Para contabilização de billing usa-se o que o provider reporta em `usage`;
 * isto serve para orçamentos de contexto antes do pedido.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  return Math.ceil(text.length / 4)
}

/** Lado do patch de imagem (14 px) — regra observada no dsh. */
export const IMAGE_PATCH_PX = 14

/** Downscale de imagens antes de tokenizar (3:1) — regra observada no dsh. */
export const IMAGE_DOWNSCALE_RATIO = 3

/** Teto de tokens por imagem — regra observada no dsh. */
export const IMAGE_TOKEN_CAP = 1024

/**
 * Tokens de uma imagem: dimensões reduzidas 3:1, divididas em patches de
 * 14×14 px, com teto de 1024 tokens por imagem (regras observadas no dsh).
 */
export function estimateImageTokens(width: number, height: number): number {
  const w = Math.max(1, Math.floor(width / IMAGE_DOWNSCALE_RATIO))
  const h = Math.max(1, Math.floor(height / IMAGE_DOWNSCALE_RATIO))
  const patches = Math.ceil(w / IMAGE_PATCH_PX) * Math.ceil(h / IMAGE_PATCH_PX)
  return Math.min(patches, IMAGE_TOKEN_CAP)
}

/**
 * Acumulador de usage ao longo de uma sessão. O `usage` real vem do
 * provider; isto expõe os totais para UI/limite de orçamento.
 */
export class TokenMeter {
  private total: LlmUsage = { ...EMPTY_USAGE }
  private readonly listeners = new Set<(delta: LlmUsage, total: LlmUsage) => void>()

  add(delta: LlmUsage): LlmUsage {
    this.total = addUsage(this.total, delta)
    for (const listener of this.listeners) listener(delta, this.total)
    return this.total
  }

  get totals(): LlmUsage {
    return { ...this.total }
  }

  reset(): void {
    this.total = { ...EMPTY_USAGE }
  }

  /** Notifica cada adição (UI de contabilização em vivo). */
  onUsage(listener: (delta: LlmUsage, total: LlmUsage) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}
