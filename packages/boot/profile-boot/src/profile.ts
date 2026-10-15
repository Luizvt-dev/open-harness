import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveDshHome } from '@open-harness/home-paths'
import { s } from '@open-harness/schemastery'
import {
  PATCH_FILE,
  PROFILE_MANIFEST,
  ProfileError,
  mergeLayers,
  parsePatch,
  type ComposedRow,
  type PatchLayer,
  type RowPatch,
} from './patch.js'

// ---------------------------------------------------------------------------
// Manifesto do perfil
// ---------------------------------------------------------------------------

/** Entrada de bundle: string, ou objecto com `required: false` (política opcional). */
export type BundleSpec = string | { name?: string; path?: string; required?: boolean }

export interface ProfileManifest {
  name?: string
  bundles: BundleSpec[]
}

const BundleObjectSchema = s.object(
  {
    name: s.string().optional(),
    path: s.string().optional(),
    required: s.boolean().optional(),
  },
  { additional: 'forbid' },
)

const ManifestSchema = s.object({
  name: s.string().optional(),
  dsh: s
    .object({
      profile: s
        .object({
          bundles: s.array(s.union([s.string(), BundleObjectSchema])).optional(),
        })
        .optional(),
    })
    .optional(),
})

// ---------------------------------------------------------------------------
// Resolução de bundles
// ---------------------------------------------------------------------------

/**
 * Resolve um bundle → caminho do seu `cordis.patch.yml`.
 * Aceita caminho (`./bundles/base`, absoluto, `file:`) ou nome de pacote
 * (caminhada `node_modules` a partir de `fromDir`, layout pnpm-friendly).
 */
export function defaultResolveBundle(spec: string, fromDir: string): string | null {
  const looksLikePath = spec.startsWith('.') || isAbsolute(spec) || spec.startsWith('file:')
  if (looksLikePath) {
    const base = spec.startsWith('file:') ? fileURLToPath(spec) : resolvePath(fromDir, spec)
    if (base.endsWith('.yml') || base.endsWith('.yaml')) return existsSync(base) ? base : null
    const candidate = join(base, PATCH_FILE)
    return existsSync(candidate) ? candidate : null
  }

  let dir = resolvePath(fromDir)
  for (;;) {
    const packageDir = join(dir, 'node_modules', spec)
    const patch = join(packageDir, PATCH_FILE)
    if (existsSync(patch)) return patch
    if (existsSync(join(packageDir, 'package.json'))) return null // pacote sem patch
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

// ---------------------------------------------------------------------------
// Composição
// ---------------------------------------------------------------------------

export interface ComposeOptions {
  /** Directório do perfil (`<home>/profiles/<name>`). */
  profileDir: string
  /** Home de dados; por omissão `resolveDshHome()`. */
  homeDir?: string
  /** Overlays `--patch` (ficheiros, em ordem; falha se não existirem). */
  overlays?: string[]
  /** Injectável: resolver bundle → caminho do patch (ou null). */
  resolveBundle?: (spec: string, fromDir: string) => string | null
  /** Avaliador de expressões `!!js`. */
  evaluate?: (expression: string) => unknown
  /** Política para bundle `required` que não resolve. Default `strict`. */
  onBundleError?: 'strict' | 'lenient'
  /** `reportSkippedBundles` — chamado para cada bundle saltado. */
  onSkip?: (event: { bundle: string; reason: string }) => void
}

export interface ComposedProfile {
  /** Linhas finais, na ordem de primeira aparição — prontas para o loader. */
  rows: ComposedRow[]
  /** Camadas aplicadas, em ordem de composição. */
  layers: { source: string; rowCount: number }[]
  manifest: ProfileManifest | null
  skipped: { bundle: string; reason: string }[]
  profileDir: string
}

/**
 * Lê o perfil e compõe as camadas:
 * `bundles (ordem do manifesto) → cordis.patch.yml do perfil → home → overlays`.
 */
export function composeProfile(options: ComposeOptions): ComposedProfile {
  const profileDir = resolvePath(options.profileDir)
  if (!existsSync(profileDir)) {
    throw new ProfileError(`profile directory not found: ${profileDir}`)
  }

  const manifest = readManifest(profileDir)
  const layers: PatchLayer[] = []
  const skipped: { bundle: string; reason: string }[] = []

  for (const entry of manifest.bundles) {
    const spec = typeof entry === 'string' ? entry : (entry.name ?? entry.path)
    const required = typeof entry === 'string' ? true : (entry.required ?? true)
    const label = spec ?? JSON.stringify(entry)

    if (!spec) {
      handleMissing(options, skipped, label, 'no-name', required)
      continue
    }

    const overridePath =
      typeof entry === 'object' && entry.path && !entry.name
        ? resolvePath(profileDir, entry.path)
        : undefined
    const patchPath = overridePath
      ? existsSync(overridePath) && (overridePath.endsWith('.yml') || overridePath.endsWith('.yaml'))
        ? overridePath
        : existsSync(join(overridePath, PATCH_FILE))
          ? join(overridePath, PATCH_FILE)
          : null
      : (options.resolveBundle ?? defaultResolveBundle)(spec, profileDir)

    if (!patchPath) {
      handleMissing(options, skipped, label, 'not-found', required)
      continue
    }

    const rows = parsePatch(readFileSync(patchPath, 'utf8'), {
      source: patchPath,
      ...(options.evaluate ? { evaluate: options.evaluate } : {}),
    })
    layers.push({ source: `bundle:${spec}`, requireDir: dirname(resolvePath(patchPath)), rows })
  }

  const profilePatch = join(profileDir, PATCH_FILE)
  if (existsSync(profilePatch)) {
    layers.push({
      source: 'profile',
      requireDir: profileDir,
      rows: parsePatch(readFileSync(profilePatch, 'utf8'), {
        source: profilePatch,
        ...(options.evaluate ? { evaluate: options.evaluate } : {}),
      }),
    })
  }

  const homeDir = resolvePath(options.homeDir ?? resolveDshHome())
  const homePatch = join(homeDir, PATCH_FILE)
  if (existsSync(homePatch)) {
    layers.push({
      source: 'home',
      requireDir: homeDir,
      rows: parsePatch(readFileSync(homePatch, 'utf8'), {
        source: homePatch,
        ...(options.evaluate ? { evaluate: options.evaluate } : {}),
      }),
    })
  }

  for (const overlay of options.overlays ?? []) {
    const overlayPath = resolvePath(overlay)
    if (!existsSync(overlayPath)) {
      throw new ProfileError(`overlay patch not found: ${overlayPath}`)
    }
    layers.push({
      source: `overlay:${overlayPath}`,
      requireDir: dirname(overlayPath),
      rows: parsePatch(readFileSync(overlayPath, 'utf8'), {
        source: overlayPath,
        ...(options.evaluate ? { evaluate: options.evaluate } : {}),
      }),
    })
  }

  return {
    rows: mergeLayers(layers),
    layers: layers.map((layer) => ({ source: layer.source, rowCount: layer.rows.length })),
    manifest,
    skipped,
    profileDir,
  }
}

function handleMissing(
  options: ComposeOptions,
  skipped: { bundle: string; reason: string }[],
  bundle: string,
  reason: string,
  required: boolean,
): void {
  if (required && options.onBundleError !== 'lenient') {
    throw new ProfileError(`bundle "${bundle}" not found (${reason})`)
  }
  skipped.push({ bundle, reason })
  options.onSkip?.({ bundle, reason })
}

function readManifest(profileDir: string): ProfileManifest {
  const manifestPath = join(profileDir, PROFILE_MANIFEST)
  if (!existsSync(manifestPath)) return { bundles: [] }

  let json: unknown
  try {
    json = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    throw new ProfileError(`invalid ${PROFILE_MANIFEST} in ${manifestPath}: ${(error as Error).message}`)
  }

  const result = ManifestSchema.validate(json)
  if (!result.ok) {
    throw new ProfileError(`invalid profile manifest ${manifestPath}: ${result.issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`)
  }

  return { name: result.value.name, bundles: result.value.dsh?.profile?.bundles ?? [] }
}

// `PatchError`/`parsePatch`/`mergeLayers` pertencem à superfície pública de
// `./patch.js`; aqui ficam só as funções de perfil.

/** Lê um único `cordis.patch.yml` (helper para previews/HMR de camada isolada). */
export function readPatchFile(path: string, evaluate?: (expression: string) => unknown): RowPatch[] | null {
  if (!existsSync(path)) return null
  return parsePatch(readFileSync(path, 'utf8'), {
    source: path,
    ...(evaluate ? { evaluate } : {}),
  })
}

/** Convenção: perfil padrão dentro do home. */
export function defaultProfileDir(name: string, homeDir?: string): string {
  return join(resolvePath(homeDir ?? resolveDshHome()), 'profiles', name)
}

/** Existe o directório de perfil? */
export function profileExists(name: string, homeDir?: string): boolean {
  return existsSync(defaultProfileDir(name, homeDir))
}
