import { Worker } from "node:worker_threads"
import { createRequire } from "node:module"

type Job = {
  operation: "hash" | "compare"
  password: string
  argument: number | string
  resolve: (value: string | boolean) => void
  reject: (error: Error) => void
  timer?: ReturnType<typeof setTimeout>
}
type Slot = { worker: Worker; job: Job | null }

function busyError() {
  return Object.assign(new Error("Authentication is busy; retry shortly"), { statusCode: 503, code: "AUTH_BUSY" })
}

/** Keep password CPU work off the API event loop, with a bounded admission queue. */
export class PasswordPool {
  private readonly slots: Slot[] = []
  private readonly queue: Job[] = []
  private closed = false
  constructor(private readonly workers = 1, private readonly maxQueued = 32, private readonly maxWaitMs = 2000) {
    if (!Number.isInteger(workers) || workers < 1 || workers > 4) throw new Error("Invalid password worker count")
  }

  hash(password: string, rounds: number): Promise<string> {
    return this.submit("hash", password, rounds) as Promise<string>
  }

  compare(password: string, hash: string): Promise<boolean> {
    return this.submit("compare", password, hash) as Promise<boolean>
  }

  private submit(operation: Job["operation"], password: string, argument: Job["argument"]): Promise<string | boolean> {
    if (this.closed) return Promise.reject(busyError())
    let slot = this.slots.find((candidate) => !candidate.job)
    if (!slot && this.slots.length < this.workers) slot = this.spawn()
    if (!slot && this.queue.length >= this.maxQueued) return Promise.reject(busyError())
    return new Promise((resolve, reject) => {
      const job: Job = { operation, password, argument, resolve, reject }
      if (slot) this.run(slot, job)
      else {
        job.timer = setTimeout(() => {
          const index = this.queue.indexOf(job)
          if (index !== -1) { this.queue.splice(index, 1); reject(busyError()) }
        }, this.maxWaitMs)
        job.timer.unref()
        this.queue.push(job)
      }
    })
  }

  private spawn() {
    // Plain JS also works in tsx development and in the compiled container, without a loader.
    const worker = new Worker(`
      const { parentPort, workerData } = require("node:worker_threads")
      const bcrypt = require(workerData.bcrypt)
      parentPort.on("message", ({operation, password, argument}) => {
        try {
          const value = operation === "hash" ? bcrypt.hashSync(password, argument) : bcrypt.compareSync(password, argument)
          parentPort.postMessage({ok:true, value})
        } catch { parentPort.postMessage({ok:false}) }
      })
    `, { eval: true, workerData: { bcrypt: createRequire(import.meta.url).resolve("bcryptjs") } })
    const slot: Slot = { worker, job: null }
    worker.on("message", (message: { ok: boolean; value: string | boolean }) => {
      const job = slot.job
      slot.job = null
      if (message.ok) job?.resolve(message.value)
      else job?.reject(new Error("Password operation failed"))
      this.next(slot)
    })
    const failed = () => {
      const index = this.slots.indexOf(slot)
      if (index === -1) return
      this.slots.splice(index, 1)
      slot.job?.reject(busyError())
      slot.job = null
      if (!this.closed && this.queue.length) this.next(this.spawn())
    }
    worker.on("error", failed)
    worker.on("exit", failed)
    worker.unref()
    this.slots.push(slot)
    return slot
  }

  private run(slot: Slot, job: Job) {
    if (job.timer) clearTimeout(job.timer)
    slot.job = job
    slot.worker.ref()
    slot.worker.postMessage({ operation: job.operation, password: job.password, argument: job.argument })
  }

  private next(slot: Slot) {
    const next = this.queue.shift()
    if (next) this.run(slot, next)
    else slot.worker.unref()
  }

  async close() {
    this.closed = true
    for (const job of this.queue.splice(0)) {
      if (job.timer) clearTimeout(job.timer)
      job.reject(busyError())
    }
    const slots = this.slots.splice(0)
    for (const slot of slots) { slot.job?.reject(busyError()); slot.job = null }
    await Promise.all(slots.map((slot) => slot.worker.terminate()))
  }
}

export const passwords = new PasswordPool(Math.max(1, Math.min(4, Number(process.env.BCRYPT_WORKERS) || 1)))
