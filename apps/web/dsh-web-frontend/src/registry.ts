// ---------------------------------------------------------------------------
// Registo de slots do documento.
//
// Uma instância por página, partilhada pelo shell e pelos plugins: o shell
// cria-a em `main.tsx` e desenha os slots; um plugin importa
// `shellRegistry` de `@open-harness/dsh-web-frontend` e inscreve-se.
//
// Funciona porque todos resolvem o MESMO módulo: o shell entra por
// `/client/dsh-web-frontend/registry.js` (relativa ao seu `main.js`) e o
// plugin pelo import map (`@open-harness/dsh-web-frontend` →
// `/client/dsh-web-frontend/index.js`), que re-exporta este ficheiro. Mesmo
// URL = mesma instância = mesmo React context, tal como o React em si.
// ---------------------------------------------------------------------------

import { SlotRegistry } from '@open-harness/dsh-client-ui-slots'

/** O registo de slots desta página. */
export const shellRegistry = new SlotRegistry()
