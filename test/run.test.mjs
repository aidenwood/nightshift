/**
 * Node's built-in runner, no dependencies.  node --test test/
 *
 * Time is injected into every lifecycle function precisely so the budget
 * behaviour — the part that matters most — is testable without sleeping.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { MAX_ATTEMPTS, done, enqueue, fail, next, parseDeadline, start, status, stop } from '../lib/run.mjs'
import { report } from '../lib/report.mjs'

const T0 = Date.UTC(2026, 0, 2, 22, 0, 0)
const MIN = 60_000
const HOUR = 60 * MIN

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'nightshift-'))
  const frozen = path.join(root, 'prompt.md')
  writeFileSync(frozen, 'original definition\n')
  return { root, frozen, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

test('parseDeadline understands durations, clock times and ISO', () => {
  assert.equal(parseDeadline('90m', T0), T0 + 90 * MIN)
  assert.equal(parseDeadline('6h', T0), T0 + 6 * HOUR)
  // A clock time already past today must mean tomorrow, not the past.
  const sevenAm = parseDeadline('07:00', T0)
  assert.ok(sevenAm > T0, 'next 07:00 must be in the future')
  assert.ok(sevenAm - T0 < 24 * HOUR, 'and within a day')
  assert.equal(parseDeadline(null, T0), null)
  assert.throws(() => parseDeadline('whenever', T0), /Could not read/)
})

test('an empty queue before the deadline is idle, never done', () => {
  const { root, cleanup } = fixture()
  start(root, 'r', { until: '8h', items: ['only task'], now: T0 })
  const claimed = next(root, 'r', T0 + MIN)
  done(root, 'r', claimed.item.id, 'finished', T0 + 2 * MIN)

  const after = next(root, 'r', T0 + 3 * MIN)
  assert.equal(after.state, 'idle', 'queue empty but 8h of budget remains')
  assert.match(after.message, /not a finish line/)

  // Only once the budget is actually spent does it become done.
  const spent = next(root, 'r', T0 + 9 * HOUR)
  assert.equal(spent.state, 'done')
  cleanup()
})

test('stop refuses any reason outside the closed set', () => {
  const { root, cleanup } = fixture()
  start(root, 'r', { until: '8h', items: ['a'], now: T0 })
  assert.throws(() => stop(root, 'r', 'nothing safe left', null, T0 + MIN), /is not a reason/)
  assert.throws(() => stop(root, 'r', '', null, T0 + MIN), /is not a reason/)
  const ok = stop(root, 'r', 'blocked', 'GPU fell off the bus', T0 + MIN)
  assert.equal(ok.reason, 'blocked')
  assert.equal(next(root, 'r', T0 + 2 * MIN).state, 'stopped')
  cleanup()
})

test('editing a frozen input mid-run contaminates the run and names the split', () => {
  const { root, frozen, cleanup } = fixture()
  start(root, 'r', { until: '8h', items: ['a', 'b'], freeze: [frozen], now: T0 })

  const first = next(root, 'r', T0 + MIN)
  assert.equal(first.contaminated, false)
  done(root, 'r', first.item.id, null, T0 + 2 * MIN)

  writeFileSync(frozen, 'CHANGED definition\n')

  const second = next(root, 'r', T0 + 3 * MIN)
  assert.equal(second.contaminated, true, 'drift must be caught on the very next claim')
  assert.deepEqual(second.drifted, [frozen])

  const text = report(root, 'r', T0 + 4 * MIN)
  assert.match(text, /contaminated/i)
  assert.match(text, /Claimed before the change \(1\)/)
  assert.match(text, /Claimed after the change \(1\)/)
  // The warning must come before the results, or it gets skimmed past.
  assert.ok(text.indexOf('contaminated') < text.indexOf('## Done'), 'trust section leads the report')
  cleanup()
})

test('a clean run reports no drift and keeps its frozen fingerprint', () => {
  const { root, frozen, cleanup } = fixture()
  start(root, 'r', { until: '1h', items: ['a'], freeze: [frozen], now: T0 })
  const snapshot = status(root, 'r', T0 + MIN)
  assert.equal(snapshot.contaminated, false)
  assert.deepEqual(snapshot.drift, [])
  assert.equal(snapshot.frozen.length, 1)
  assert.match(report(root, 'r', T0 + MIN), /byte-identical/)
  cleanup()
})

test('a forgotten done does not stall the queue on one item', () => {
  const { root, cleanup } = fixture()
  start(root, 'r', { until: '8h', items: ['a', 'b', 'c'], now: T0 })
  const one = next(root, 'r', T0 + MIN)
  const two = next(root, 'r', T0 + 2 * MIN)
  const three = next(root, 'r', T0 + 3 * MIN)
  const ids = new Set([one.item.id, two.item.id, three.item.id])
  assert.equal(ids.size, 3, 'fresh items are handed out before anything is retried')
  cleanup()
})

test('an item claimed MAX_ATTEMPTS times without completing is abandoned, not looped on', () => {
  const { root, cleanup } = fixture()
  start(root, 'r', { until: '8h', items: ['poison'], now: T0 })
  for (let i = 0; i < MAX_ATTEMPTS; i++) next(root, 'r', T0 + (i + 1) * MIN)
  const after = next(root, 'r', T0 + 10 * MIN)
  assert.equal(after.state, 'idle', 'the poisoned item must leave the queue')
  assert.equal(after.counts.failed, 1)
  assert.match(report(root, 'r', T0 + 11 * MIN), /abandoned after/)
  cleanup()
})

test('a failed item is requeued rather than dropped', () => {
  const { root, cleanup } = fixture()
  start(root, 'r', { until: '8h', items: ['a'], now: T0 })
  const claimed = next(root, 'r', T0 + MIN)
  fail(root, 'r', claimed.item.id, 'OOM', { requeue: true }, T0 + 2 * MIN)
  const again = next(root, 'r', T0 + 3 * MIN)
  assert.equal(again.state, 'item')
  assert.equal(again.item.id, claimed.item.id, 'the same work comes back around')
  cleanup()
})

test('fail without a reason is rejected', () => {
  const { root, cleanup } = fixture()
  start(root, 'r', { until: '1h', items: ['a'], now: T0 })
  const claimed = next(root, 'r', T0 + MIN)
  assert.throws(() => fail(root, 'r', claimed.item.id, '', {}, T0 + 2 * MIN), /needs --reason/)
  cleanup()
})

test('a run resumes from its log rather than restarting', () => {
  const { root, cleanup } = fixture()
  start(root, 'r', { until: '8h', items: ['a', 'b', 'c'], now: T0 })
  const first = next(root, 'r', T0 + MIN)
  done(root, 'r', first.item.id, 'ok', T0 + 2 * MIN)
  // Simulate a crash: nothing else is held in memory, state is re-read from disk.
  const resumed = status(root, 'r', T0 + 3 * MIN)
  assert.equal(resumed.counts.done, 1)
  assert.equal(resumed.counts.pending, 2)
  cleanup()
})

test('work added mid-run joins the queue', () => {
  const { root, cleanup } = fixture()
  start(root, 'r', { until: '8h', items: ['a'], now: T0 })
  const claimed = next(root, 'r', T0 + MIN)
  done(root, 'r', claimed.item.id, null, T0 + 2 * MIN)
  assert.equal(next(root, 'r', T0 + 3 * MIN).state, 'idle')
  enqueue(root, 'r', [{ task: 'b' }, 'c'], T0 + 4 * MIN)
  const more = next(root, 'r', T0 + 5 * MIN)
  assert.equal(more.state, 'item')
  assert.equal(more.counts.total, 3)
  cleanup()
})

test('the report lists work that failed on its way back to pending', () => {
  const { root, cleanup } = fixture()
  start(root, 'r', { until: '8h', items: ['flaky'], now: T0 })
  const claimed = next(root, 'r', T0 + MIN)
  fail(root, 'r', claimed.item.id, 'source 404ed', { requeue: true }, T0 + 2 * MIN)
  const text = report(root, 'r', T0 + 3 * MIN)
  assert.match(text, /Never reached/)
  assert.match(text, /tried 1×, last: source 404ed/, 'a requeued failure must not look untouched')
  cleanup()
})

test('starting a run that is already running is refused', () => {
  const { root, cleanup } = fixture()
  start(root, 'r', { until: '8h', items: ['a'], now: T0 })
  assert.throws(() => start(root, 'r', { until: '8h', items: ['b'], now: T0 + MIN }), /already running/)
  cleanup()
})

test('freezing a file that does not exist fails loudly at start', () => {
  const { root, cleanup } = fixture()
  assert.throws(() => start(root, 'r', { until: '1h', freeze: [path.join(root, 'nope.md')], now: T0 }), /Cannot freeze/)
  cleanup()
})
