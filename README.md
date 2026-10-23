# nightshift

**A durable work queue that keeps long, unattended AI agent runs honest.**

Zero dependencies. Node 18+. Works with Claude Code, or any agent, or a bash loop.

---

You tell an agent "you've got 8 hours, work through this overnight." In the
morning you find one of three things, and none of them is the thing you asked
for:

- It **stopped at hour two** because it ran out of ideas it felt confident
  about, and sat idle for six hours.
- It **finished everything**, but someone edited the prompt halfway through, so
  items 1–8 and items 9–20 were made to different specs. Nothing errored. The
  set looks complete and is internally inconsistent.
- The laptop slept, the process died, and **nobody knows which items finished.**

nightshift is a small CLI that makes all three structurally difficult.

```bash
nightshift start blog-night \
  --until 07:00 \
  --goal "One post per keyword cluster, 900+ words" \
  --items clusters.json \
  --freeze house-style.md,brand.json

nightshift next blog-night --json    # claim
nightshift done blog-night <id> --note "1,100 words, 3 internal links"

nightshift report blog-night --out NIGHT.md
```

## What it actually enforces

### The budget is a floor, not a ceiling

When the queue empties before the deadline, `next` returns `idle` — never
`done` — and exits **3**, so a wrapper script can't mistake it for success:

```
The queue is empty but the budget is NOT spent. This is not a finish line.
Do one of these, then call `next` again:
  1. Enqueue more work: more variations of whatever is already working.
  2. Try the lower-confidence idea you set aside — label it an experiment.
  3. Deepen the work already done: verify it, extend it, test the edges.
```

And ending a run needs a reason from a closed list:

```bash
$ nightshift stop blog-night --reason "nothing safe left"
nightshift: "nothing safe left" is not a reason to end a resourced run.
Valid reasons:
  complete  Every queued item is done AND the goal is literally achieved.
  blocked   A hard technical blocker no retry can clear.
  user      A human explicitly said stop.
```

### A mid-run edit can't silently split your batch

`--freeze` snapshots and hashes every input the run must treat as fixed. Every
single claim re-checks them. Change one byte at item 9 and the run is marked
contaminated, the morning report leads with it, and it tells you exactly where
the batch split:

```markdown
## ⚠️ This batch is contaminated — do not ship it as one set

A frozen input changed at 2026-10-23 02:14, mid-run:

- `house-style.md`

Claimed before the change (8): a1f2, b3c4, …
Claimed after the change (12): k9j8, m2n1, …
```

The frozen *copies* are kept too, not just the hashes — so "what was the prompt
actually saying at 2am" has an answer on disk instead of being reconstructed
from a git history that may not have a commit for it.

### Crashes resume, they don't restart

State is an append-only JSONL event log. A `kill -9` mid-write loses at most a
partial final line; the item it described is still queued and simply runs again.
Items claimed but never completed come back at the *end* of the queue — so a
crash is retried, but one forgotten `done` can't stall the whole night on a
single item. After 3 claims without completing, an item is abandoned loudly and
reported rather than eating the run.

### One page in the morning, not 4,000 log lines

`nightshift report` answers, in this order: *is any of this trustworthy*, what
got done, what broke, what never got reached, and how it ended. Trust comes
first on purpose — a contaminated batch that reads as a clean one is worse than
one that obviously failed, because it gets used.

## Install

No package manager, no build step, no `npx`:

```bash
git clone https://github.com/aidenwood/nightshift.git ~/.nightshift-cli
ln -s ~/.nightshift-cli/bin/nightshift /usr/local/bin/nightshift
nightshift --help
```

As a Claude Code skill:

```bash
ln -s ~/.nightshift-cli ~/.claude/skills/nightshift
```

## Commands

```
nightshift start <run> --until 07:00 [--goal "..."] [--items file] [--freeze f,…]
nightshift add   <run> --items <file|->      enqueue more work mid-run
nightshift next  <run> [--json]              claim the next item
nightshift done  <run> <id> [--note "..."]
nightshift fail  <run> <id> --reason "..." [--requeue]
nightshift status <run>
nightshift report <run> [--out report.md]
nightshift stop  <run> --reason complete|blocked|user [--note "..."]
nightshift list
```

`--until` takes `6h`, `90m`, `07:00`, or an ISO timestamp.
`--items` takes a JSON array, JSONL, or `-` for stdin; entries are strings or
objects.

State lives in `./.nightshift/<run>/` inside a git repo, `~/.nightshift/<run>/`
outside one. Override with `--dir`.

Runs are also registered in `~/.nightshift/runs.json`, so a run started in one
repo is reachable from anywhere — a long run routinely spans repos, and having
to `cd` back to wherever it started just to record an item finished somewhere
else is friction that shows up at 3am. The registry is a cache, never the
source of truth: entries are verified against the filesystem on read, so a
deleted run falls out instead of becoming a dangling pointer.

## A worked loop

```bash
nightshift start renders --until 8h --items shots.json --freeze scene.py

while true; do
  OUT=$(nightshift next renders --json); CODE=$?
  STATE=$(echo "$OUT" | jq -r .state)

  [ "$STATE" = "done" ] && break
  if [ $CODE -eq 3 ]; then
    # idle: budget remains. Generate more work rather than exiting.
    ./enqueue-more-variations.sh | nightshift add renders --items -
    continue
  fi

  ID=$(echo "$OUT" | jq -r .item.id)
  if ./render.sh "$(echo "$OUT" | jq -r .item.shot)"; then
    nightshift done renders "$ID" --note "$(ls -1 out/ | tail -1)"
  else
    nightshift fail renders "$ID" --reason "render exited non-zero" --requeue
  fi
done

nightshift report renders --out MORNING.md
```

## Why these three rules

They aren't hypothetical. Each came from a run that wasted a real night:

- A 30-hour render budget ended after ~4 hours because the agent judged the
  remaining ideas too risky to try unattended. The GPU idled all night and the
  window was gone by morning.
- A batch of 12 image renders read its config live. An edit applied to item 9
  while 1–8 carried the old one. No error, no warning, and a set that was
  worthless because its members weren't comparable.
- Seven files on one machine each claimed to hold *the* approved version of the
  same prompt. Three separate sessions "restored the approved version" and got
  three different results.

See [`references/rules.md`](references/rules.md) for the full write-ups.

## License

MIT
