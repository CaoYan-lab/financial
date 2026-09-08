const DEFAULT_MIN_INTERVAL_MS = 30

type LongbridgeSdkScheduler = {
  wrap<T extends object>(context: T): T
}

export function createLongbridgeSdkScheduler(
  minIntervalMs = Number(
    process.env.LONGBRIDGE_SDK_MIN_INTERVAL_MS || DEFAULT_MIN_INTERVAL_MS,
  ),
): LongbridgeSdkScheduler {
  const intervalMs = Math.max(
    20,
    Number.isFinite(minIntervalMs) ? minIntervalMs : DEFAULT_MIN_INTERVAL_MS,
  )
  let queue: Promise<void> = Promise.resolve()
  let nextCallAt = 0

  return {
    wrap<T extends object>(context: T): T {
      return new Proxy(context, {
        get(target, property, receiver) {
          const value = Reflect.get(target, property, receiver)
          if (typeof value !== 'function') return value
          return (...args: unknown[]) => {
            const request = queue
              .catch(() => undefined)
              .then(async () => {
                const waitMs = nextCallAt - Date.now()
                if (waitMs > 0) {
                  await new Promise((resolve) => setTimeout(resolve, waitMs))
                }
                nextCallAt = Date.now() + intervalMs
                return Reflect.apply(value, target, args)
              })
            queue = request.then(() => undefined, () => undefined)
            return request
          }
        },
      })
    },
  }
}
