// ---------------------------------------------------------------------------
// `dsh-client-ui-slots` — slots da interface.
//
// O shell declara slots nomeados; os plugins inscrevem componentes neles. O
// núcleo (`./registry.js`) não conhece React; os bindings (`./react.js`) dão
// o `<SlotProvider>`, o `<Slot>` e o `useRegisterSlot`.
// ---------------------------------------------------------------------------

export {
  SlotRegistry,
  type RegisterOptions,
  type SlotComponent,
  type SlotEntry,
  type SlotListener,
  type SlotName,
} from './registry.js'
export {
  Slot,
  SlotProvider,
  useRegisterSlot,
  useSlotEntries,
  useSlotRegistry,
} from './react.js'
