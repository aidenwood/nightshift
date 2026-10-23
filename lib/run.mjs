/**
 * Run lifecycle. The opinions live here.
 *
 * A nightshift run has a *budget* — a wall-clock deadline, an item count, or
 * both. The budget is a FLOOR the run works to, not a ceiling it is allowed to
 * declare reached. Running out of queued work is not the same as being finished,
 * and this module is deliberately built so the difference is impossible to blur:
 * an empty queue before the deadline returns `idle`, never `done`, and `stop`
 * refuses any reason outside a fixed list.
 *
 * That is the whole point of the tool. Everything else — the queue, the freeze,
 * the report — exists so an agent can be trusted to work unattended for eight
 * hours without either lying about what it did or quietly stopping at hour two.
 */
import { randomUUID } from 'node:crypto'
import { EVENTS, Store } from './store.mjs'

/** How many times an item may be claimed without completing before it is abandoned. */
export const MAX_ATTEMPTS = 3

/** The only reasons a run may end before its budget is spent. */
export const STOP_REASONS = {
  complete: 'Every queued item is done AND the goal is literally achieved — not "nothing safe is left".',
  blocked: 'A hard technical blocker no retry can clear (credentials gone, service down, disk full).',
  user: 'A human explicitly said stop.',
}

export function parseDeadline(until, now) {
  if (!until) return null
  // "90m" / "6h" — a duration from now.
  const rel = /^(\d+(?:\.\d+)?)(m|h)$/.exec(until.trim())
  if (rel) {
    const mins = Number(rel[1]) * (rel[2] === 'h' ? 60 : 1)
    return now + mins * 60_000
  }
  // "07:00" — the next time that clock time occurs.
  const clock = /^(\d{1,2}):(\d{2})$/.exec(until.trim())
  if (clock) {
    const target = new Date(now)
    target.setHours(Number(clock[1]), Number(clock[2]), 0, 0)
    let stamp = target.getTime()
    if (stamp <= now) stamp += 24 * 60 * 60 * 1000
    return stamp
  }
  const abs = Date.parse(until)
  if (!Number.isNaN(abs)) return abs
  throw new Error(`Could not read --until "${until}". Use 6h, 90m, 07:00, or an ISO timestamp.`)
}

export function start(root, name, { until, items = [], freeze = [], goal, now }) {
  const store = new Store(root, name)
  if (store.exists) {
    const run = store.readRun()
    if (run.status === 'running') throw new Error(`Run "${name}" is already running. Use \`nightshift status ${name}\` or resume with \`nightshift next ${name}\`.`)
  }
  const deadline = parseDeadline(until, now)
  store.create({ name, goal: goal ?? null, startedAt: now, deadline, status: 'running', frozen: [], stop: null })
  const frozen = store.freeze(freeze, now)
  store.writeRun({ name, goal: goal ?? null, startedAt: now, deadline, status: 'running', frozen, stop: null })
  store.append(EVENTS.RUN_STARTED, { goal: goal ?? null, deadline, frozenFingerprint: store.frozenFingerprint() }, now)
  const added = enqueue(root, name, items, now)
  return { store, deadline, added }
}

export function enqueue(root, name, items, now) {
  const store = new Store(root, name)
  store.readRun()
  const added = []
  for (const raw of items) {
    const item = typeof raw === 'string' ? { task: raw } : { ...raw }
    const id = item.id ?? randomUUID().slice(0, 8)
    delete item.id
    store.append(EVENTS.ENQUEUED, { id, item }, now)
    added.push(id)
  }
  return added
}

/**
 * Hand out the next item — or, when the queue is empty but time remains, say so
 * in the one way that cannot be mistaken for "finished".
 */
export function next(root, name, now) {
  const store = new Store(root, name)
  const run = store.readRun()

  if (run.status !== 'running') {
    return { state: 'stopped', reason: run.stop?.reason ?? 'unknown', message: `Run "${name}" was stopped (${run.stop?.reason}). Start a new one to continue.` }
  }

  // Drift check on every claim, not once at start: the edit that poisons a batch
  // lands in the middle of it, which is exactly when nobody is looking.
  const drifted = store.drift()
  if (drifted.length && !run.contaminated) {
    run.contaminated = { at: now, files: drifted.map((d) => d.file) }
    store.writeRun(run)
    store.append(EVENTS.DRIFT_DETECTED, { files: drifted.map((d) => d.file) }, now)
  }

  const items = store.items()

  // An item claimed too many times without ever completing is poison — usually a
  // prompt the model cannot satisfy or an input that always throws. Retrying it
  // forever burns the whole night on one item, which is the failure mode a
  // resumable queue invites. Fail it loudly and move on; the report lists it.
  for (const item of items) {
    if (item.state === 'claimed' && item.attempts >= MAX_ATTEMPTS) {
      store.append(EVENTS.FAILED, { id: item.id, reason: `abandoned after ${item.attempts} attempts without completing` }, now)
      item.state = 'failed'
    }
  }

  const fresh = items.filter((i) => i.state === 'pending')
  const inFlight = items.filter((i) => i.state === 'claimed')
  // Fresh work first. An item still marked `claimed` is either a crash the run
  // is resuming from or an agent that forgot to call `done` — either way it is
  // retried only once the untouched queue is empty, so one forgotten `done`
  // cannot stall the entire night on a single item.
  const pending = [...fresh, ...inFlight]
  const overdue = run.deadline !== null && now >= run.deadline

  if (!pending.length) {
    if (overdue) return { state: 'done', message: 'Queue empty and the budget is spent. Run `nightshift report` and finish.', ...summary(store, run, now) }
    return {
      state: 'idle',
      remainingMs: run.deadline === null ? null : run.deadline - now,
      message: IDLE_MESSAGE,
      ...summary(store, run, now),
    }
  }

  const item = pending[0]
  const frozenHash = store.frozenFingerprint()
  store.append(EVENTS.CLAIMED, { id: item.id, frozenHash }, now)
  return {
    state: 'item',
    item: { ...item, state: undefined },
    attempts: item.attempts + 1,
    contaminated: Boolean(run.contaminated),
    drifted: drifted.map((d) => d.file),
    remainingMs: run.deadline === null ? null : run.deadline - now,
    ...summary(store, run, now),
  }
}

const IDLE_MESSAGE = [
  'The queue is empty but the budget is NOT spent. This is not a finish line.',
  'Do one of these, then call `next` again:',
  '  1. Enqueue more work: more variations of whatever is already working.',
  '  2. Try the lower-confidence idea you set aside — label it an experiment.',
  '  3. Deepen the work already done: verify it, extend it, test the edges.',
  'Stopping here needs `nightshift stop --reason complete|blocked|user`,',
  'and "nothing safe is left to do" is none of those.',
].join('\n')

export function done(root, name, id, note, now) {
  const store = new Store(root, name)
  store.readRun()
  if (!store.items().some((i) => i.id === id)) throw new Error(`No item "${id}" in run "${name}".`)
  store.append(EVENTS.DONE, { id, note: note ?? null }, now)
  return { id, state: 'done' }
}

export function fail(root, name, id, reason, { requeue = false }, now) {
  const store = new Store(root, name)
  store.readRun()
  if (!store.items().some((i) => i.id === id)) throw new Error(`No item "${id}" in run "${name}".`)
  if (!reason) throw new Error('`fail` needs --reason. An unexplained failure is indistinguishable from a crash in the morning.')
  store.append(EVENTS.FAILED, { id, reason }, now)
  // A failed item is requeued, never dropped — a render that OOMs at 2am should
  // be retried at 3am, not silently missing from the morning's set.
  if (requeue) store.append(EVENTS.REQUEUED, { id }, now)
  return { id, state: requeue ? 'requeued' : 'failed' }
}

export function stop(root, name, reason, note, now) {
  const store = new Store(root, name)
  const run = store.readRun()
  if (!(reason in STOP_REASONS)) {
    throw new Error(
      [
        `"${reason}" is not a reason to end a resourced run.`,
        'Valid reasons:',
        ...Object.entries(STOP_REASONS).map(([k, v]) => `  ${k.padEnd(9)} ${v}`),
        '',
        'If the queue is empty but time remains, that is `idle`, not done — enqueue more work.',
      ].join('\n')
    )
  }
  run.status = 'stopped'
  run.stop = { reason, note: note ?? null, at: now }
  store.writeRun(run)
  store.append(EVENTS.RUN_ENDED, { reason, note: note ?? null }, now)
  return { name, reason }
}

export function summary(store, run, now) {
  const items = store.items()
  const count = (state) => items.filter((i) => i.state === state).length
  return {
    run: run.name,
    goal: run.goal,
    status: run.status,
    contaminated: Boolean(run.contaminated),
    counts: {
      total: items.length,
      pending: count('pending'),
      claimed: count('claimed'),
      done: count('done'),
      failed: count('failed'),
    },
    elapsedMs: now - run.startedAt,
    remainingMs: run.deadline === null ? null : Math.max(0, run.deadline - now),
  }
}

export function status(root, name, now) {
  const store = new Store(root, name)
  const run = store.readRun()
  return { ...summary(store, run, now), frozen: run.frozen, drift: store.drift(), stop: run.stop }
}
