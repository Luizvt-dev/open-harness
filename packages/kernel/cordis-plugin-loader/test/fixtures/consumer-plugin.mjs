/** Consumidor: só activa quando `hot.value` existir (independente da ordem das linhas). */
export default {
  name: 'consumer',
  inject: ['hot.value'],
  apply(ctx) {
    ctx.set('consumer.seen', ctx.get('hot.value'))
  },
}
