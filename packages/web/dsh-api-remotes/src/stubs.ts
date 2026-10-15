import { RemoteError, type RemoteSpec, type UnaryMethodSpec } from '@open-harness/dsh-api-gateway'

/**
 * Resposta honesta para o que ainda não existe.
 *
 * Preferimos `unavailable` com o motivo a um stub que devolve vazio: o cliente
 * mostra "ainda não" em vez de fingir que correu.
 */
function notImplemented(what: string, why: string): UnaryMethodSpec<never, never> {
  return {
    handler: () => {
      throw new RemoteError('unavailable', `${what} is not available: ${why}`)
    },
  }
}

/** Remote `terminal.*` — fica para a Fase 5 (exige `node-pty`). */
export function terminalRemote(): RemoteSpec {
  return {
    namespace: 'terminal',
    methods: {
      open: notImplemented('terminal', 'needs a pty (Fase 5)'),
      write: notImplemented('terminal', 'needs a pty (Fase 5)'),
      resize: notImplemented('terminal', 'needs a pty (Fase 5)'),
    },
  }
}

/** Remote `account.*` — esta recriação não tem provedor de contas. */
export function accountRemote(): RemoteSpec {
  return {
    namespace: 'account',
    methods: {
      profile: notImplemented('account', 'no account provider in this build'),
    },
  }
}
