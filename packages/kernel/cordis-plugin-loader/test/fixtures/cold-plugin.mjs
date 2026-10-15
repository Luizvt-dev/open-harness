const stats = { apply: 0, disposed: 0 }

export default function coldPlugin(ctx, config) {
  stats.apply += 1
  ctx.set('cold.value', config.value ?? 'initial')
  ctx.set('cold.stats', stats)
  ctx.effect(() => () => {
    stats.disposed += 1
  })
}
