# Why nightshift behaves the way it does

Three rules, three incidents. Each rule exists because prose alone did not
prevent a repeat — so the tool enforces it mechanically instead.

---

## 1. A stated budget is a floor, not a ceiling

**The incident.** An overnight render loop was given 30 hours of GPU time. It ran
roughly 8 good iterations over about 4 hours, then the agent judged every
remaining idea too risky to attempt unattended and declared itself finished.
~26 hours went unused. By morning the machine was needed for something else, so
the window was gone permanently — not deferred, gone.

**Why prose didn't stop it.** "Don't stop early" reads like advice, and
"I have run out of ideas I'm confident in" feels like a legitimate completion
rather than the failure it is. The agent was not being lazy; it had genuinely
exhausted its *safe* list and conflated that with exhausting its *work*.

**What the tool does.**

- An empty queue before the deadline returns `idle`, never `done`, with the
  three moves spelled out: enqueue more of what's working, try the
  lower-confidence idea as a labelled experiment, or go deeper on what exists.
- `next --json` exits **3** on idle, so a `while` loop keyed on exit status
  cannot silently treat "ran out of queued work" as "finished".
- `stop` takes a reason from a closed set. "Nothing safe is left" is not in it,
  and the error message says so by name.

**The distinction that matters.** Running out of *queued work* is a scheduling
problem — generate more. Running out of *things worth doing* is a judgment call
the person who set the budget already made when they set it.

---

## 2. Never change a definition mid-run

**The incident.** A batch of 12 image renders read its prompt configuration live
from disk. A correction was made partway through. Items 1–8 rendered against the
old definition, items 9–12 against the new one. No error. No warning. The set
completed "successfully" and was worthless, because the entire point of the
batch was that its members be comparable with each other.

It then happened a second time, the next day, in a session that had explicitly
quoted the rule back before starting.

**Why prose didn't stop it.** The edit is always well-intentioned — someone
spots a real fault and fixes it. The damage is invisible: hot-reload means
nothing crashes, nothing logs, and the output looks like a complete set.

**What the tool does.**

- `--freeze` takes a byte copy *and* a hash of every input at run start.
- Every single `next` re-hashes them — not once at the start, because the edit
  lands in the middle, which is exactly when nobody is watching.
- One byte of difference marks the run contaminated permanently. The report
  leads with it, above the results, and lists which item IDs were claimed before
  and after the split.
- The frozen copies stay on disk. When a run turns out to have produced
  something good, "what was the prompt actually saying" is answerable without
  relying on a git commit that may not exist.

**The corollary.** If you find a fault mid-run, either let the batch finish, or
stop it cleanly and restart the whole thing. Patching and continuing produces
two half-batches wearing one name. And tell the user the moment it happens —
handing over a mixed set in the morning is worse than the original mistake.

---

## 3. One definition, in one place, changed in place

**The incident.** Seven files on one machine each held a version of the same
character-definition prompt — `thing`, `thing_v2`, `thing_core`, `thing_fix`,
`thing_check`, and two variants inside one file labelled `BLOCK_A` and
`BLOCK_B`. Each had been created by a session "restoring the approved version"
by copying it somewhere new. Each was documented somewhere as the canonical one.
They contradicted each other, so three separate sessions in one morning
"restored the approved version" and produced three different results.

**Why prose didn't stop it.** Forking feels safe — you're preserving the old one
"just in case". But a fork is not a ratchet, it is a coin toss, and it only
reveals itself as one later, when nobody can tell which file won.

**What the tool does.**

- `--freeze` points at the real file in its real location. There is no "copy it
  somewhere safe first" step to get wrong, because the tool takes the snapshot.
- The snapshot lives in run state, out of the import path, named by hash — a
  readable dead file, never an importable live one.
- The report prints the frozen fingerprint, so two runs can be compared on
  whether they actually used the same inputs instead of on whether someone
  remembers.

**The corollary.** If a comparison genuinely needs two variants, run them as two
*inputs* — two runs, two seeds — and delete the loser. Never leave two live
definitions behind.

---

## A fourth, smaller one: evidence beats memory

A `--note` on `done` is not decoration. Outputs rarely store their inputs, so
the note is where the thing that *proves* an item worked goes: the word count,
the output path, the seed, the artefact name. Provenance is the difference
between knowing and guessing, and without it the next session re-derives the
answer — often wrongly.

Never record "verified working" for something that has not actually been run.
A change without evidence is a hypothesis; label it as one.
