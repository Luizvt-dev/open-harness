const stats = { apply: 0, reconfigure: 0, disposed: 0 }

export default {
  name: 'hot-plugin',
  apply(ctx, config) {
    stats.apply += 1
    this.ctx = ctx
    ctx.set('hot.value', config.value ?? 'initial')
    ctx.set('hot.stats', stats)
    ctx.effect(() => () => {
      stats.disposed += 1
    })
  },
  reconfigure(config) {
    stats.reconfigure += 1
    this.ctx.set('hot.value', config.value ?? 'initial')
  },
}
