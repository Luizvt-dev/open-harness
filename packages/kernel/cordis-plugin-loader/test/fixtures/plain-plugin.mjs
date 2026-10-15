/** Plugin sem serviço single — duas linhas podem carregá-lo em paralelo. */
export default function plainPlugin(ctx, config) {
  ctx.provide('plain.values', { multiple: true })
  ctx.set('plain.values', config.value ?? 'x')
}
