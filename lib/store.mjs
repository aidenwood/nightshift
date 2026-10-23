/**
 * The durable half of a run: an append-only event log plus a frozen copy of
 * every input the run was told to treat as fixed.
 *
 * Append-only, not mutable state, for two reasons. A crash or a kill -9 at any
 * point leaves a file that still parses — you lose at most the partial last
 * line, never the run. And the log IS the morning report: "which items used
 * which version of the prompt" is answerable because every claim recorded the
 * hash it ran under, not because something remembered to write a summary.
 */
import { createHash } from 'node:crypto'
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'

export const EVENTS = {
  RUN_STARTED: 'run_started',
  ENQUEUED: 'enqueued',
  CLAIMED: 'claimed',
  DONE: 'done',
  FAILED: 'failed',
  REQUEUED: 'requeued',
  NOTE: 'note',
  DRIFT_DETECTED: 'drift_detected',
  RUN_ENDED: 'run_ended',
}

export function hashFile(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 16)
}

export class Store {
  constructor(root, name) {
    this.name = name
    this.dir = path.join(root, name)
    this.runFile = path.join(this.dir, 'run.json')
    this.logFile = path.join(this.dir, 'events.jsonl')
    this.frozenDir = path.join(this.dir, 'frozen')
  }

  get exists() {
    return existsSync(this.runFile)
  }

  create(meta) {
    mkdirSync(this.frozenDir, { recursive: true })
    writeFileSync(this.runFile, `${JSON.stringify(meta, null, 2)}\n`)
    if (!existsSync(this.logFile)) writeFileSync(this.logFile, '')
  }

  readRun() {
    if (!this.exists) throw new Error(`No run named "${this.name}". Start one with: nightshift start ${this.name} …`)
    return JSON.parse(readFileSync(this.runFile, 'utf8'))
  }

  writeRun(meta) {
    writeFileSync(this.runFile, `${JSON.stringify(meta, null, 2)}\n`)
  }

  /** `now` is injected so a run is reproducible and testable; never read the clock down here. */
  append(event, payload, now) {
    appendFileSync(this.logFile, `${JSON.stringify({ t: now, event, ...payload })}\n`)
  }

  events() {
    if (!existsSync(this.logFile)) return []
    return readFileSync(this.logFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .flatMap((line) => {
        // A torn final line from a hard kill is the one thing this format can
        // lose. Drop it rather than crashing a resume on it — the item it
        // described is still in the queue, unclaimed, and will simply run again.
        try {
          return [JSON.parse(line)]
        } catch {
          return []
        }
      })
  }

  /**
   * Folds the log into the current state of every item. Items are keyed by id;
   * last event wins. `claimed` without a following `done`/`failed` means the run
   * died mid-item — those come back as claimable, because an overnight run that
   * silently drops the item it was working on when the laptop slept is worse
   * than one that does it twice.
   */
  items() {
    const byId = new Map()
    for (const e of this.events()) {
      if (!e.id) continue
      const prev = byId.get(e.id) ?? { id: e.id, attempts: 0 }
      if (e.event === EVENTS.ENQUEUED) byId.set(e.id, { ...prev, ...e.item, id: e.id, state: 'pending' })
      else if (e.event === EVENTS.CLAIMED) byId.set(e.id, { ...prev, state: 'claimed', attempts: prev.attempts + 1, frozenHash: e.frozenHash })
      else if (e.event === EVENTS.DONE) byId.set(e.id, { ...prev, state: 'done', note: e.note })
      else if (e.event === EVENTS.FAILED) byId.set(e.id, { ...prev, state: 'failed', reason: e.reason })
      else if (e.event === EVENTS.REQUEUED) byId.set(e.id, { ...prev, state: 'pending' })
    }
    return [...byId.values()]
  }

  /**
   * Copies every frozen input and records its hash. The copy matters as much as
   * the hash: when a run turns out to have produced something good, "what was
   * the prompt actually saying at 2am" has an answer sitting on disk, instead of
   * being reconstructed from a git history that may not have a commit for it.
   */
  freeze(files, now) {
    const manifest = []
    for (const file of files) {
      const abs = path.resolve(file)
      if (!existsSync(abs)) throw new Error(`Cannot freeze a file that does not exist: ${file}`)
      const hash = hashFile(abs)
      const stored = `${hash}__${path.basename(abs)}`
      copyFileSync(abs, path.join(this.frozenDir, stored))
      manifest.push({ file: abs, hash, stored })
    }
    this.append(EVENTS.NOTE, { note: `froze ${manifest.length} input(s)` }, now)
    return manifest
  }

  /**
   * Re-hashes every frozen input. Returns the ones that no longer match.
   *
   * This is the check that turns "never change a definition mid-run" from a rule
   * someone has to remember into one the tool enforces. A batch where item 9 ran
   * under a different prompt than items 1–8 is not a batch, it is two half
   * batches that look like one — and it fails silently, which is why it has to
   * be detected rather than avoided by discipline.
   */
  drift() {
    const run = this.readRun()
    return (run.frozen ?? [])
      .filter((entry) => !existsSync(entry.file) || hashFile(entry.file) !== entry.hash)
      .map((entry) => ({
        ...entry,
        nowHash: existsSync(entry.file) ? hashFile(entry.file) : null,
        missing: !existsSync(entry.file),
      }))
  }

  frozenFingerprint() {
    const run = this.readRun()
    const parts = (run.frozen ?? []).map((f) => f.hash).join('|')
    return parts ? createHash('sha256').update(parts).digest('hex').slice(0, 12) : 'none'
  }

  listFrozen() {
    return existsSync(this.frozenDir) ? readdirSync(this.frozenDir) : []
  }
}
