/**
 * The morning report.
 *
 * The output of an eight-hour unattended run is not the log — nobody reads
 * 4,000 lines over coffee. It is one page that answers, in this order: is any of
 * this trustworthy, what got done, what broke, and what should happen next.
 *
 * Trustworthiness comes first on purpose. A contaminated batch that reads as a
 * clean one is worse than a batch that obviously failed, because it gets used.
 */
import { EVENTS, Store } from './store.mjs'
import { summary } from './run.mjs'

const ms = (value) => {
  if (value === null || value === undefined) return 'no limit'
  const mins = Math.round(value / 60_000)
  if (mins < 60) return `${mins}m`
  return `${Math.floor(mins / 60)}h ${mins % 60}m`
}

const stamp = (t) => new Date(t).toISOString().replace('T', ' ').slice(0, 16)

export function report(root, name, now) {
  const store = new Store(root, name)
  const run = store.readRun()
  const sum = summary(store, run, now)
  const items = store.items()
  const events = store.events()
  const lines = []

  lines.push(`# ${run.name}`)
  lines.push('')
  if (run.goal) lines.push(`**Goal** — ${run.goal}`)
  lines.push(`**Ran** ${stamp(run.startedAt)} → ${stamp(now)} (${ms(sum.elapsedMs)} of ${ms(run.deadline === null ? null : run.deadline - run.startedAt)})`)
  lines.push('')

  // 1. Can this be trusted?
  if (sum.contaminated) {
    const drifted = run.contaminated.files
    lines.push('## ⚠️ This batch is contaminated — do not ship it as one set')
    lines.push('')
    lines.push(`A frozen input changed at ${stamp(run.contaminated.at)}, mid-run:`)
    lines.push('')
    for (const file of drifted) lines.push(`- \`${file}\``)
    lines.push('')
    lines.push('Items claimed before that moment ran under a different definition than')
    lines.push('items claimed after it. The outputs are not comparable with each other.')
    lines.push('Re-run the whole batch against one frozen version before using any of it.')
    lines.push('')
    const split = run.contaminated.at
    const before = events.filter((e) => e.event === EVENTS.CLAIMED && e.t < split).map((e) => e.id)
    const after = events.filter((e) => e.event === EVENTS.CLAIMED && e.t >= split).map((e) => e.id)
    lines.push(`Claimed before the change (${before.length}): ${before.join(', ') || '—'}`)
    lines.push('')
    lines.push(`Claimed after the change (${after.length}): ${after.join(', ') || '—'}`)
    lines.push('')
  } else if (run.frozen?.length) {
    lines.push(`✅ All ${run.frozen.length} frozen input(s) were byte-identical for the whole run.`)
    lines.push('')
  }

  // 2. What got done.
  const done = items.filter((i) => i.state === 'done')
  const failed = items.filter((i) => i.state === 'failed')
  const left = items.filter((i) => i.state === 'pending' || i.state === 'claimed')

  lines.push(`## Done — ${done.length} of ${items.length}`)
  lines.push('')
  if (done.length) {
    for (const item of done) {
      const label = item.task ?? item.title ?? item.id
      lines.push(`- **${label}**${item.note ? ` — ${item.note}` : ''}`)
    }
  } else {
    lines.push('_Nothing completed._')
  }
  lines.push('')

  if (failed.length) {
    lines.push(`## Failed — ${failed.length}`)
    lines.push('')
    for (const item of failed) lines.push(`- **${item.task ?? item.id}** — ${item.reason} _(${item.attempts} attempt${item.attempts === 1 ? '' : 's'})_`)
    lines.push('')
  }

  if (left.length) {
    lines.push(`## Never reached — ${left.length}`)
    lines.push('')
    lines.push('These were queued and the run ended first. They are still pending, so')
    lines.push('starting another run picks them up where this one left off.')
    lines.push('')
    for (const item of left) {
      // An item that failed and was requeued is still pending, so it would
      // otherwise appear here as if it had never been touched — hiding the fact
      // that it fought and lost two or three times during the night.
      const struggle = item.attempts > 0 ? ` _(tried ${item.attempts}×${item.reason ? `, last: ${item.reason}` : ''})_` : ''
      lines.push(`- ${item.task ?? item.id}${struggle}`)
    }
    lines.push('')
  }

  // 3. How it ended — and whether that was legitimate.
  lines.push('## How it ended')
  lines.push('')
  if (run.stop) {
    lines.push(`Stopped: **${run.stop.reason}**${run.stop.note ? ` — ${run.stop.note}` : ''}`)
    if (run.stop.reason === 'blocked') {
      lines.push('')
      lines.push('A blocked run has unspent budget. Clear the blocker and start another')
      lines.push('run over the same queue — the pending items above are still pending.')
    }
  } else if (sum.remainingMs && sum.remainingMs > 60_000) {
    lines.push(`Still running, **${ms(sum.remainingMs)}** of budget left.`)
  } else {
    lines.push('Budget spent.')
  }
  lines.push('')

  lines.push('---')
  lines.push('')
  lines.push(`\`${items.length}\` items · \`${events.length}\` events · frozen fingerprint \`${store.frozenFingerprint()}\``)
  lines.push('')
  return lines.join('\n')
}
