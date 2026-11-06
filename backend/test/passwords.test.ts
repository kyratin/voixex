import { test } from "node:test"
import assert from "node:assert/strict"
import { PasswordPool } from "../src/passwords.js"

test("password hashing stays off the event loop and validates existing bcrypt hashes", async () => {
  const pool = new PasswordPool()
  let ticks = 0
  const timer = setInterval(() => ticks++, 2)
  try {
    const hash = await pool.hash("a test password", 10)
    assert.ok(ticks > 5, `API timer only ran ${ticks} times during bcrypt work`)
    assert.equal(await pool.compare("a test password", hash), true)
    assert.equal(await pool.compare("wrong", hash), false)
  } finally { clearInterval(timer); await pool.close() }
})

test("password queue rejects excess work and expires queued requests", async () => {
  const pool = new PasswordPool(1, 1, 5)
  try {
    const running = pool.hash("first", 10)
    const queued = pool.hash("second", 10)
    const overflow = pool.hash("third", 10)
    await assert.rejects(overflow, { code: "AUTH_BUSY", statusCode: 503 })
    await assert.rejects(queued, { code: "AUTH_BUSY", statusCode: 503 })
    assert.match(await running, /^\$2/)
  } finally { await pool.close() }
})
