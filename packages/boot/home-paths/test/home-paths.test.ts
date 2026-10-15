import { describe, expect, it } from 'vitest'
import { join, resolve } from 'node:path'
import {
  ALT_HOME_ENV,
  DEFAULT_HOME_DIR,
  HOME_ENV,
  dshHomePath,
  getHomePaths,
  resolveDshHome,
} from '@open-harness/home-paths'

describe('resolveDshHome', () => {
  it('OPEN_HARNESS_HOME tem prioridade', () => {
    const home = resolveDshHome({ env: { [HOME_ENV]: '/tmp/oh-home' } })
    expect(home).toBe(resolve('/tmp/oh-home'))
  })

  it('OHSH_HOME é o fallback do override', () => {
    const home = resolveDshHome({ env: { [ALT_HOME_ENV]: '/tmp/alt-home' } })
    expect(home).toBe(resolve('/tmp/alt-home'))
  })

  it('sem override usa ~/.open-harness', () => {
    const home = resolveDshHome({ env: {}, homedir: '/home/teste' })
    expect(home).toBe(join('/home/teste', DEFAULT_HOME_DIR))
  })

  it('DSH_HOME é deliberadamente ignorado (não colide com o dsh real)', () => {
    const home = resolveDshHome({ env: { DSH_HOME: '/tmp/dsh-real' }, homedir: '/home/teste' })
    expect(home).toBe(join('/home/teste', DEFAULT_HOME_DIR))
  })
})

describe('dshHomePath / getHomePaths', () => {
  it('dshHomePath junta segmentos ao home resolvido (usa process.env)', () => {
    const previous = process.env[HOME_ENV]
    process.env[HOME_ENV] = '/tmp/oh-home'
    try {
      expect(dshHomePath('sessions', 'abc')).toBe(join(resolve('/tmp/oh-home'), 'sessions', 'abc'))
    } finally {
      if (previous === undefined) delete process.env[HOME_ENV]
      else process.env[HOME_ENV] = previous
    }
  })

  it('getHomePaths deriva a árvore de directórios', () => {
    const paths = getHomePaths({ env: { [HOME_ENV]: '/tmp/oh-home' } })
    expect(paths.home).toBe(resolve('/tmp/oh-home'))
    expect(paths.profiles).toBe(join(paths.home, 'profiles'))
    expect(paths.profile('desktop')).toBe(join(paths.home, 'profiles', 'desktop'))
    expect(paths.profilePatch('desktop')).toBe(join(paths.home, 'profiles', 'desktop', 'cordis.patch.yml'))
    expect(paths.homePatch).toBe(join(paths.home, 'cordis.patch.yml'))
    expect(paths.sessions).toBe(join(paths.home, 'sessions'))
    expect(paths.storages).toBe(join(paths.home, 'storages'))
    expect(paths.attachments).toBe(join(paths.home, 'attachments'))
    expect(paths.credentials).toBe(join(paths.home, '.credentials.yaml'))
  })
})
