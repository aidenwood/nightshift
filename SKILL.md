---
name: nightshift
description: Use when running long unattended work — an overnight batch, a multi-hour render queue, a "work on this for 6 hours" or "keep going until morning" instruction, or any /loop with a stated time budget. Gives the run a durable queue that survives crashes, freezes the inputs so a mid-run edit can't silently split the batch, refuses to let the run end early, and writes a morning report. Also use when resuming a run that was interrupted.
---

# nightshift

Long unattended runs fail in three specific ways. This skill exists because
each one is invisible until the morning, when the work is already wasted.

| Failure | What it looks like | What nightshift does |
|---|---|---|
| **Stopping early** | "I ran out of safe ideas at hour two" — 26 of 30 hours idle | An empty queue before the deadline returns `idle`, never `done`. `stop` refuses any reason outside `complete`/`blocked`/`user`. |
| **Silent contamination** | Someone edits the prompt at item 9; items 1–8 used the old one; the set is internally inconsistent and nothing errors | Frozen inputs are hashed on **every** claim. One byte changes → the run is marked contaminated and the report leads with it. |
| **Losing the thread** | Laptop sleeps, process dies, nobody knows which items finished | Append-only event log. Resume picks up exactly where it stopped. |

## The contract

**A stated budget is a floor, not a ceiling.** "You have 8 hours" means work for
8 hours. Running out of queued work is *not* running out of things to do.

When `next` returns `idle`, you have three moves and none of them is stopping:

1. Enqueue more of whatever is already working.
2. Try the lower-confidence idea you set aside — label it an experiment.
3. Go deeper on what's done: verify it, extend it, test the edges.

Only `complete` (the goal is literally achieved), `blocked` (a hard technical
blocker no retry clears), or `user` (a human said stop) end a run early.

## Workflow

Start the run. Freeze anything that must not change mid-batch — the prompt, the
config, the style guide, the schema:

```bash
nightshift start blog-night \
  --until 07:00 \
  --goal "One post per keyword cluster, 900+ words, 3 internal links each" \
  --items clusters.json \
  --freeze house-style.md,brand.json
```

Then loop. Claim, do the work, record the outcome:

```bash
nightshift next blog-night --json     # → {"state":"item","item":{…}}
# …do the work…
nightshift done blog-night <id> --note "1,100 words, 3 links"
nightshift fail blog-night <id> --reason "source 404'd" --requeue
```

`next` exits **3** on `idle` so a shell wrapper can't mistake it for success.

In the morning:

```bash
nightshift report blog-night --out NIGHT.md
```

## Before the first run in a repo

Add `.nightshift/` to that repo's `.gitignore`. The state is an append-only log
that changes on every claim, so tracking it means every command dirties the
working tree of the project you are also committing real work to.

## Rules while a run is live

- **Never edit a frozen file.** Queue the correction and apply it between runs.
  If you already did, the report says so — say so too, don't bury it.
- **Never patch and continue.** A fault found mid-run either lets the batch
  finish, or stops it cleanly and restarts the whole thing. Patching halfway
  produces a set that is two half-batches wearing one name.
- **Say the batch is contaminated the moment it happens.** Handing over a mixed
  set at 7am is worse than the original mistake.
- **A failed item is requeued, not dropped.** A render that OOMs at 2am gets
  retried at 3am. After 3 claims without completing, it is abandoned loudly and
  appears in the report rather than eating the night.
- **Record what proves it.** `--note` on `done` is where the evidence goes —
  word count, output path, seed, the artefact that makes the claim checkable.

## Through-day runs

Same engine, different cadence. Use a relative budget and check in rather than
sleeping through it:

```bash
nightshift start audit-sweep --until 6h --items repos.json
```

Pair with the `/loop` skill for the wake-ups; nightshift holds the state so each
wake-up resumes rather than restarts.

## Reference

- `references/rules.md` — the incidents each rule came from
- `references/recipes.md` — render queues, blog batches, migration sweeps
- `nightshift --help` · `nightshift reasons`
