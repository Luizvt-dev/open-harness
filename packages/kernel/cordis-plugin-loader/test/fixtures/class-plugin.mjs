const stats = { apply: 0 }

export default class ClassPlugin {
  apply(ctx, config) {
    stats.apply += 1
    ctx.set('class.value', config.value ?? 'default')
    ctx.set('class.stats', stats)
  }
}
