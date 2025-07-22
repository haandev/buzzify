# 🐝 Buzzify — A Type-Safe Web Worker RPC & Pooling Library

Buzzify is a powerful utility that makes it effortless to manage **type-safe, bidirectional RPC communication** between the main thread and Web Workers — while providing a **concurrent worker pool** out-of-the-box.

> 🧠 Inspired by nature. Designed for speed, reliability, and elegance.

---

## ✨ Features

- ✅ **Typed RPC**: Define request and response types for each method across threads.
- 🔁 **Bidirectional communication**: Workers can also call imperative main-thread methods.
- 📡 **Event system**: Emit and listen to typed custom events.
- 🧵 **Worker pool management**: Handle concurrency with dynamic pool resizing.
- 🧘 **Fire-and-forget support**: For commands that don’t require a response.
- 🧪 **Fault tolerance**: Ping-check, automatic recovery, graceful fallback.
- 🧼 **Disposable workers**: `Symbol.dispose` and `using` support.

---

## 📦 Installation

```bash
npm install buzzify
# or your favorite package manager
```

## 🚀 Quick Start

```ts
// on your worker.ts
import { defineBee } from 'buzzify'
declare const self: Worker
const bee = defineBee<{
  WorkerMethods: {
    add: {
        args: [number, number]
        return: number
    }
  }
  Event: { log: [string] }
  MainMethods: {  hello: (name: string) => Promise<string> }
}>(self)

bee.handle('add', (a, b) => a + b)
bee.handle('hi', async () => {
    bee.call('hello', 'John')
})

bee.emit('log', 'Worker started')

// on your main.ts
import { useBee } from 'buzzify'
import type { MyBeeApi } from './worker.ts'

const bee = useBee<MyBeeApi>(new URL('/worker.js', import.meta.url))

const result = await bee.call('add', 1, 2)
console.log(result)

// events is accessor for EventListener instance which composed on bee instance
bee.events.on('log', (message) => {
  console.log(message)
  // will log Worker started
})
```

## 🐝 Calling main-thread methods from worker:

```ts
//on your main.ts
import { useBee } from 'buzzify'
import type { MyBeeApi } from './worker.ts'

const bee = useBee<MyBeeApi>(new URL('/worker.js', import.meta.url), {
    hello: async (name) => {
        return `Hello, ${name}!`
    }
})

bee.send('hi') //after a while you will see Hello, John! in console who defined in main.ts
```



# 🐝 Worker Pool

Buzzify also provides a robust pool implementation for running tasks concurrently.

```ts
import { createBeeHive } from 'buzzify'
import type { MyBeeApi } from './worker.ts'

const pool = createBeeHive<MyBeeApi>(new URL('./worker.ts', import.meta.url), {
  concurrency: 4,
  handlers: {
    hello: (name) => `Hello, ${name}!`,
  },
})

//you can acquire a worker from the pool
const worker = await pool.acquire()
// this will return a worker instance or wait for a worker to be available

//you can call methods on the worker
await worker.call('add', 1, 2)

//when you are done, you can release the worker back to the pool
pool.release(worker)
````
### Auto release by `using`
```ts
if (true) {
    using worker = await pool.acquire() 
    worker.call('add', 1, 2)
}
// here worker will be released back to the pool because of the `using` keyword
````

### To systems who has no `using` keyword
```ts
await pool.using(worker => {
    worker.call('add', 1, 2)
})
// here worker will be released back to the pool because of the `using` method of the pool
```

### Event system

beeHive instance has `events` accessor for EventListener instance which composed on beeHive instance. And its events are predefined. You can not define new events. They are:
```ts
export type HiveEventsMap<M extends BeeApi> = {
  workerAcquired: (reason?: any) => void
  workerReleased: (item: PoolItem<M>, initialReason?: any) => void
  workerReserved: (item: PoolItem<M>) => void
  workerRemoved: (item: PoolItem<M>) => void
  workerCreated: (item: PoolItem<M>) => void
}
````

But the bee itself, has `events` accessor for EventListener instance which composed on bee instance. And its events are not predefined. You should define them on the BeeApi type.

```ts
export type MyBeeApi = {
  //...
  Events: {
    log: [string]
  }
}

//on your worker.ts
const bee = defineBee<MyBeeApi>(self)
bee.emit('log', 'Worker started')

//on your main.ts
const bee = useBee<MyBeeApi>(new URL('/worker.js', import.meta.url))
bee.events.on('log', (message) => {
  console.log(message)
})
```

## 🧪 Testing Responsiveness
Every worker has ping method who can calleble from main thread.
```ts
const bee = useBee<MyBeeApi>(new URL('/worker.js', import.meta.url))
const result = await bee.ping()
console.log(result) //this will log pong
```

## 📊 Pool State Snapshot
```ts
console.log(pool.state)
/*
{
  poolSize: 4,
  desiredPoolSize: 4,
  busyWorkers: [{ workerId: 1, reason: 'math' }],
  idleWorkers: [2, 3, 4],
  waitingList: []
}
*/
```

## 🧩 Type Utilities

- `InferBeeApi<T>`: Extract the BeeApi from a defineBee instance.

## 🧠 Why "Buzzify"?

Because like bees:

- 🐝 Your workers are fast, efficient, and never idle.
- 🧠 The hive (pool) manages them with intelligence.
- 🛠 Communication is clean and organized.