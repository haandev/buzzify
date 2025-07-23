import { EventListener, EventTupleToHandler } from '@haandev/core/event'

type MethodShape<Input extends any[] = any[], Output = any> = (
  ...args: Input
) => Output
type HasVoid<T> = Extract<T, void> extends never ? false : true
type PromisifyMethodReturn<F extends (...args: any[]) => any> = (
  ...args: Parameters<F>
) => HasVoid<ReturnType<F>> extends true
  ? Promise<Awaited<ReturnType<F>>> | void
  : Promise<Awaited<ReturnType<F>>>

type Methods = Record<string, MethodShape>
type MethodParts<Args extends any[] = any[], Return = any> = {
  args: Args
  return?: Return
}
type EventMap = Record<string, any[]>

type BeeApi<
  W extends Methods = Methods,
  E extends EventMap = EventMap,
  M extends Methods = Methods,
> = {
  workerHandlers?: W
  events?: E
  mainHandlers?: M
}

/**
 * Creates and sets up a type-safe message handler interface for a Web Worker.
 *
 * This function binds message handling logic between the main thread and the
 * worker thread, enabling RPC-style request/response communication as well as
 * event emission.
 *
 * It also provides an API to register handler functions that the main thread
 * can invoke from the worker, emit events to the main thread, or call
 * imperative functions on the main thread.
 *
 * @example
 *   ;```ts
 *   declare var self: Worker
 *   const api = createWorkerHandler<MyBeeApi>(self)
 *
 *   api.handle('add', async (a, b) => a + b)
 *   api.emit('ready') // notify main thread
 *   ```
 */
export function defineBee<A extends BeeApi>(worker: Worker) {
  type Events = NonNullable<A['events']>
  type WorkerMethods = NonNullable<A['workerHandlers']>
  type PromisifiedMethods = {
    [key in keyof WorkerMethods]: PromisifyMethodReturn<WorkerMethods[key]>
  }
  type MainMethods = NonNullable<A['mainHandlers']>
  type WorkerMethodArgsUnion = Parameters<WorkerMethods[keyof WorkerMethods]>

  let requestId = 100
  const handlers: PromisifiedMethods = {} as PromisifiedMethods
  const callbacks = new Map<number, { resolve: Function; reject: Function }>()
  worker.addEventListener(
    'message',
    async (
      event: MessageEvent<
        | {
            type: 'request'
            id: number | null
            method: keyof WorkerMethods
            args: MethodParts['args']
          }
        | {
            type: 'response'
            id: number
            result: MethodParts['return']
          }
      >,
    ) => {
      switch (event.data.type) {
        case 'request':
          const { id, method, args } = event.data
          try {
            const handler = handlers[method]
            const result = await handler?.(...(args as WorkerMethodArgsUnion))
            if (id === null) return
            worker.postMessage({ type: 'response', id, result })
          } catch (error) {
            if (id === null) return
            worker.postMessage({
              type: 'response',
              id,
              error: error instanceof Error ? error.message : String(error),
            })
          }
          break
        case 'response':
          const cb = callbacks.get(event.data.id)
          if (cb) {
            const error = (event.data as any).error
            error ? cb.reject(new Error(error)) : cb.resolve(event.data.result)
            callbacks.delete(event.data.id)
          }
          break
      }
    },
  )

  // keep the worker alive even if there is an unhandled rejection
  worker.addEventListener('unhandledrejection', (event) => {
    event.preventDefault()
    console.error('Unhandled rejection:', event)
  })

  worker.addEventListener('error', (event) => {
    console.error('Worker error:', event)
  })

  const api = {
    /**
     * Registers an asynchronous handler function for a specific method. The
     * method will be invoked when a corresponding request is received from the
     * main thread.
     */
    handle: <K extends keyof WorkerMethods>(
      method: K,
      fn: (
        ...args: Parameters<WorkerMethods[K]>
      ) => Promise<Awaited<ReturnType<WorkerMethods[K]>>>,
    ) => {
      handlers[method] = fn
      return api
    },
    /**
     * Emits an event from the worker to the main thread. Useful for sending
     * progress updates, logs, or any custom notifications.
     */
    emit: <K extends keyof Events>(event: K, ...args: Events[K]) => {
      ;(worker as any).postMessage({ type: 'event', method: event, args })
    },

    /**
     * Sends a fire-and-forget message to the worker. Does not wait for a
     * response. Use this for commands that do not return data but may emit
     * events handled via on/once/off.
     */
    send: <K extends keyof WorkerMethods>(
      method: K,
      ...args: Parameters<WorkerMethods[K]>
    ) => {
      worker.postMessage({ type: 'worker-call', id: null, method, args })
    },

    /**
     * Calls an imperative function from the worker. Imperative functions are
     * functions that are on main thread
     */
    call: <K extends keyof MainMethods>(
      imperative: K,
      ...args: Parameters<MainMethods[K]>
    ): Promise<Awaited<ReturnType<MainMethods[K]>>> => {
      const callId = ++requestId
      worker.postMessage({
        type: 'request',
        id: callId,
        method: imperative,
        args,
      })
      return new Promise((resolve, reject) => {
        callbacks.set(callId, { resolve, reject })
      })
    },

    // 💡 marker
    __api: null as unknown as A,
  }
  api.handle('ping', async () => 'pong' as any)
  return api
}

/** Exposes a worker to the main thread. */
export class ExposedBee<T extends BeeApi> {
  private requestId = 100
  private readonly callbacks = new Map<
    number,
    { resolve: Function; reject: Function }
  >()
  private readonly _events = new EventListener<
    EventTupleToHandler<NonNullable<T['events']>>
  >()
  private readonly _worker: Worker
  private readonly _handlers?: T['mainHandlers']

  constructor(
    scriptURL: string | URL,
    handlers?: T['mainHandlers'],
    options?: WorkerOptions,
  ) {
    this._worker = new Worker(scriptURL, options)
    this._handlers = handlers
    this.raw.addEventListener('message', this.handleMessage)
  }

  private handleMessage = async (event: MessageEvent) => {
    const data = event.data
    switch (data.type) {
      case 'response': {
        const cb = this.callbacks.get(data.id)
        if (cb) {
          data.error
            ? cb.reject(new Error(data.error))
            : cb.resolve(data.result)
          this.callbacks.delete(data.id)
        }
        break
      }

      case 'event': {
        this._events.emit(data.method, ...data.args)
        break
      }

      case 'request': {
        try {
          const handler = this._handlers?.[data.method]
          const result = await handler?.(...data.args)
          if (data.id !== null) {
            this.raw.postMessage({ type: 'response', id: data.id, result })
          }
        } catch (error) {
          if (data.id !== null) {
            this.raw.postMessage({
              type: 'response',
              id: data.id,
              error: error instanceof Error ? error.message : String(error),
            })
          }
        }
        break
      }
    }
  }
  /**
   * Calls a method exposed by the worker and awaits its response. Returns a
   * Promise that resolves with the result or rejects on error.
   */
  public async call<K extends keyof NonNullable<T['workerHandlers']>>(
    method: K,
    ...args: Parameters<NonNullable<T['workerHandlers']>[K]>
  ): Promise<Awaited<ReturnType<NonNullable<T['workerHandlers']>[K]>>> {
    const id = ++this.requestId
    this.raw.postMessage({ type: 'request', id, method, args })
    return new Promise<
      Awaited<ReturnType<NonNullable<T['workerHandlers']>[K]>>
    >((resolve, reject) => {
      this.callbacks.set(id, { resolve, reject })
    })
  }
  /**
   * Sends a fire-and-forget message to the worker. Does not wait for a
   * response. Use this for commands that do not return data but may emit events
   * handled via on/once/off.
   */
  public send<K extends keyof NonNullable<T['workerHandlers']>>(
    method: K,
    ...args: Parameters<NonNullable<T['workerHandlers']>[K]>
  ): void {
    this.raw.postMessage({ type: 'request', id: null, method, args })
  }
  /** Full access to the events via EventHandler instance */
  public get events() {
    return this._events
  }
  /** Terminates the worker immediately. Any ongoing tasks will be stopped. */
  public terminate(): void {
    this.raw.terminate()
  }
  /**
   * Pings the worker to check if it is responsive.
   *
   * @returns 'pong' if the worker is responsive, otherwise throws an error.
   */
  public ping(): Promise<'pong'> {
    return this.call('ping' as any, ...([] as any)) as Promise<'pong'>
  }
  /** Returns the raw worker instance. */
  public get raw() {
    return this._worker
  }
}

export type InferBeeApi<T> = T extends { __api: infer A } ? A : never
interface ExposedWorkerWithRelease<T extends BeeApi> extends ExposedBee<T> {
  release: () => void
  [Symbol.dispose]: () => void
  [Symbol.asyncDispose]: () => Promise<void>
  who: () => number
}
type PoolItem<T extends BeeApi> = {
  worker: ExposedWorkerWithRelease<T>
  state: 'idle' | 'busy'
  reason?: any
  _id: number
}
/**
 * Exposes a worker to the main thread. This is a convenience function that
 * simplifies creating a worker without dealing with the ExposedWorker class.
 */
export const useBee = <T extends BeeApi>(
  scriptURL: string | URL,
  handlers?: T['mainHandlers'],
  options?: WorkerOptions,
) => {
  return new ExposedBee<T>(scriptURL, handlers, options)
}
export type HiveEventsMap<M extends BeeApi> = {
  workerAcquired: (reason?: any) => void
  workerReleased: (item: PoolItem<M>, initialReason?: any) => void
  workerReserved: (item: PoolItem<M>) => void
  workerRemoved: (item: PoolItem<M>) => void
  workerCreated: (item: PoolItem<M>) => void
}
/**
 * Manages a pool of web workers to enable concurrent task execution with
 * controlled concurrency.
 *
 * Supports acquiring and releasing workers, automatic creation/removal based on
 * desired pool size, waiting queue when all workers are busy, and events for
 * lifecycle hooks.
 *
 * Each worker is wrapped in an `ExposedWorkerWithRelease` that supports easy
 * disposal via `.release()` and symbol-based disposers.
 *
 * @example
 *   ;```ts
 *   const pool = new WorkerPool<MyBeeApi>('/worker.js', { concurrency: 4 })
 *
 *   const worker = await pool.acquire('do important task')
 *   const result = await worker.call('someWorkerMethod', arg1, arg2)
 *   worker.release()
 *   ```
 *
 * @template T - The worker API interface describing the worker and main
 *   methods.
 */
export class BeeHive<T extends BeeApi> {
  private _id = 0
  private _events = new EventListener<HiveEventsMap<T>>()
  private _isPaused = false
  private readonly desiredPoolSize: { current: number }
  private readonly pool: PoolItem<T>[] = []
  private readonly waiters: {
    resolve: (worker: ExposedWorkerWithRelease<T>) => void
    reason?: any
  }[] = []

  constructor(
    private readonly scriptURL: string | URL,
    private readonly config: { concurrency: number },
    private readonly handlers?: T['mainHandlers'],
    private readonly options?: WorkerOptions,
  ) {
    this.desiredPoolSize = { current: this.config.concurrency }
    this.resize()
  }

  private attachRelease(worker: ExposedBee<T>): ExposedWorkerWithRelease<T> {
    if ('release' in worker && Symbol.dispose in worker) {
      return worker as ExposedWorkerWithRelease<T>
    }
    const releaseFn = () => this.release(worker as ExposedWorkerWithRelease<T>)
    const keys = ['release', Symbol.dispose, Symbol.asyncDispose] as const
    for (const key of keys) {
      Object.defineProperty(worker, key, {
        value: releaseFn,
        writable: false,
        configurable: false,
      })
    }
    return worker as ExposedWorkerWithRelease<T>
  }

  private createWorker() {
    const id = this._id++
    const rawWorker = new ExposedBee<T>(
      this.scriptURL,
      this.handlers,
      this.options,
    )
    const worker = this.attachRelease(rawWorker)
    Object.defineProperty(worker, 'who', {
      value: () => id,
      writable: false,
      configurable: false,
    })
    const item: PoolItem<T> = {
      worker,
      state: 'idle',
      _id: id,
      reason: undefined,
    }
    this.pool.push(item)
    this._events.emit('workerCreated', item)
  }

  private removeWorker(item?: (typeof this.pool)[number]) {
    if (!item) return
    try {
      item.worker.terminate()
    } catch {}
    this.pool.splice(this.pool.indexOf(item), 1)
    this._events.emit('workerRemoved', item)
  }

  /**
   * Reserves a worker from the pool. It will return the first idle worker or
   * undefined if there is no idle worker.
   */
  private reserve(reason?: any): ExposedWorkerWithRelease<T> | undefined {
    if (this._isPaused) return undefined
    const item = this.pool.find((w) => w.state === 'idle')
    if (item) {
      item.state = 'busy'
      item.reason = reason
      this._events.emit('workerReserved', item)
      return item.worker
    }
    return undefined
  }

  /** Releases a worker back to the pool. */
  private release(worker: ExposedWorkerWithRelease<T>) {
    const item = this.pool.find((w) => w.worker === worker)
    if (!item) return

    if (this.pool.length > this.desiredPoolSize.current) {
      this.removeWorker(item)
      return
    }
    const initialReason = item.reason
    item.state = 'idle'
    item.reason = undefined
    const next = this.waiters.shift()
    if (next) {
      item.state = 'busy'
      next.resolve(item.worker)
    }
    this._events.emit('workerReleased', item, initialReason)
  }

  /**
   * Acquires a worker from the pool. If the pool is empty, it will wait for a
   * worker to be released. If the worker is not responsive, it will remove it
   * from the pool and try to acquire a new one.
   *
   * @example
   *   ```ts
   *   const worker = await pool.acquire()
   *   await worker.call('doSomething')
   *   worker.release()
   *   ```
   *   The acquired worker is coming with Symbol.dispose and Symbol.asyncDispose methods.
   *   So calling acquire with 'using' will automatically release the worker after the function is executed.
   *
   * @example
   *   ;```ts
   *   {
   *     using worker = await pool.acquire()
   *     await worker.call('doSomething')
   *   }
   *   // worker is released here automatically because out of scope
   *   ```
   *
   * @param reason - The reason for acquiring the worker. It will be shown on
   *   state (pool.state)
   * @returns A worker from the pool.
   */
  async acquire(
    reason?: any,
    retries = 3,
  ): Promise<ExposedWorkerWithRelease<T>> {
    if (retries < 0) {
      throw new Error('Could not acquire a responsive worker')
    }
    const worker =
      this.reserve(reason) ||
      (await new Promise<ExposedWorkerWithRelease<T>>((resolve) =>
        this.waiters.push({ resolve, reason }),
      ))
    this._events.emit('workerAcquired', reason)
    try {
      const pong = await Promise.race([
        worker.ping(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Ping timeout')), 1000),
        ),
      ])
      if (pong === 'pong') return worker
      else throw new Error('Invalid ping result')
    } catch (error) {
      this.removeWorker(this.pool.find((w) => w.worker === worker))
      if (this.pool.length < this.desiredPoolSize.current) {
        this.resize()
      }
      return this.acquire(reason, retries - 1)
    }
  }

  /**
   * Acquires a worker from the pool and releases it after the function is
   * executed.
   *
   * @example
   *   ;```ts
   *   const worker = await pool.using(async (worker) => {
   *     await worker.call('doSomething')
   *   })
   *   ```
   */
  async using<R>(
    fn: (worker: ExposedWorkerWithRelease<T>) => Promise<R>,
  ): Promise<R> {
    const worker = await this.acquire()
    try {
      return await fn(worker)
    } finally {
      this.release(worker)
    }
  }
  /**
   * Resizes the pool to the desired size. If desired is not provided, it will
   * behave like refresh. If desired is less than the current size, it will
   * remove the idle workers. Than release workers will remove themselves until
   * the desired size is reached. If desired is greater than the current size,
   * it will create new workers immediately.
   */
  resize(desired?: number) {
    if (!desired) desired = this.desiredPoolSize.current
    this.desiredPoolSize.current = desired

    // Remove idle workers
    for (let i = 0; i < this.pool.length; i++) {
      if (this.pool.length <= desired) break
      const w = this.pool[i]
      if (w.state !== 'idle') continue
      this.removeWorker(w)
    }

    // Create new workers if needed
    while (this.pool.length < desired) {
      this.createWorker()
    }
  }

  /** Returns the current state of the pool. */
  get state() {
    return {
      poolSize: this.pool.length,
      desiredPoolSize: this.desiredPoolSize.current,
      waitingList: this.waiters.map((w) => w.reason),
      busyWorkers: this.pool
        .filter((w) => w.state === 'busy')
        .map((w) => ({ workerId: w._id, reason: w.reason })),
      idleWorkers: this.pool
        .filter((w) => w.state === 'idle')
        .map((w) => w._id),
    }
  }

  toJSON() {
    return this.state
  }

  toString() {
    return `[ WorkerPool(poolSize: ${this.pool.length}, desiredPoolSize: ${this.desiredPoolSize.current}, busyCount: ${this.pool.filter((w) => w.state === 'busy').length}, idleCount: ${this.pool.filter((w) => w.state === 'idle').length}) ]`
  }

  [Symbol.toStringTag]() {
    return this.toString()
  }

  /** Pauses the pool. */
  pause() {
    this._isPaused = true
  }
  private drainWaiters() {
    while (this.waiters.length > 0) {
      const item = this.pool.find((w) => w.state === 'idle')
      if (!item) break

      const next = this.waiters.shift()
      if (!next) break

      item.state = 'busy'
      item.reason = next.reason
      next.resolve(item.worker)
    }
  }
  /** Resumes the pool. */
  resume() {
    this._isPaused = false
    this.drainWaiters()
  }

  /** Full access to the events via EventHandler instance */
  get events() {
    return this._events
  }
}
/**
 * Creates and initializes a new `WorkerPool` instance with the given
 * configuration.
 *
 * This is a convenience factory function that simplifies creating a worker pool
 * without dealing with the WorkerPool class directly.
 */
export function createBeeHive<T extends BeeApi>(
  scriptURL: string | URL,
  options: {
    concurrency: number
    handlers?: T['mainHandlers']
    workerOptions?: WorkerOptions
  },
) {
  return new BeeHive<T>(
    scriptURL,
    { concurrency: options.concurrency },
    options.handlers,
    options.workerOptions,
  )
}
