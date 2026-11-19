# Cross-machine build resume

Use this when a `knowdit_kg_build` is **already in progress** and must continue
on another computer. For a fresh start, see `AGENTS.md` §13 instead.

Resume is defined by build state, not by the repository. The code, dataset
manifest, KG, journal, cache, model, and context window must all be the same
identity. Mixing any of them is refused by the journal fingerprint.

## Invariants

| Component | Requirement |
| --- | --- |
| Code | Same commit / `PIPELINE_VERSION` |
| Dataset | Same `data/dataset`, including the exact `manifest.json` bytes |
| Model | Same provider, model id, and effort variant (`high` or above) |
| Window | Same context window reported by OpenCode |
| KG | `data/kg.sqlite` from the same run |
| Journal | `data/runs.sqlite` from the same run |
| Cache | `data/cache/` from the same run (optional but strongly recommended) |

`manifest.generatedAt` is part of the fingerprint. **Do not run
`knowdit_dataset_prepare` while resuming** — it rewrites `generatedAt` and makes
the journal unusable.

## 1. Record identity before the build

Pin the code:

```bash
git tag -a phase1-p0p1.4 -m "Phase 1 pipeline p0p1.4"
git push origin phase1-p0p1.4
```

After the first units have run, record:

```bash
sha256sum data/dataset/manifest.json
sqlite3 data/runs.sqlite \
  "select value from journal_meta where key='build_fingerprint';"
```

Keep both values with the snapshot.

## 2. Snapshot on the current machine

Stop building first. Do not reset. `sqlite3 .backup` produces a consistent
single-file copy even when the database uses WAL.

```bash
set -euo pipefail
SNAP="${1:-$HOME/knowdit-state/$(date +%Y%m%d-%H%M%S)}"
mkdir -p "$SNAP"

sqlite3 data/kg.sqlite   ".backup '$SNAP/kg.sqlite'"
sqlite3 data/runs.sqlite ".backup '$SNAP/runs.sqlite'"

cp -a data/dataset "$SNAP/dataset"
if [ -d data/cache ]; then cp -a data/cache "$SNAP/cache"; fi

sha256sum data/dataset/manifest.json > "$SNAP/manifest.sha256"
sqlite3 data/runs.sqlite \
  "select value from journal_meta where key='build_fingerprint';" \
  > "$SNAP/fingerprint.txt"
```

Transfer over a private channel (SSH, private object storage, or Syncthing):

```bash
rsync -av --partial "$SNAP/" user@other-machine:~/knowdit-state/import/
```

Never commit build state to the public repository.

## 3. Restore on the other machine

```bash
cd ~/knowdit-opencode
git fetch --all --tags
git checkout phase1-p0p1.4
npm ci

# Replace the target state completely, including stale WAL/SHM files.
rm -f data/kg.sqlite data/kg.sqlite-wal data/kg.sqlite-shm
rm -f data/runs.sqlite data/runs.sqlite-wal data/runs.sqlite-shm
rm -rf data/dataset data/cache

cp "$SNAP/kg.sqlite" "$SNAP/runs.sqlite" data/
cp -a "$SNAP/dataset" data/
if [ -d "$SNAP/cache" ]; then cp -a "$SNAP/cache" data/; fi
```

## 4. Verify identity before resuming

Run these from the repository root:

```bash
git rev-parse HEAD
sha256sum -c "$SNAP/manifest.sha256"
cat "$SNAP/fingerprint.txt"
sqlite3 data/runs.sqlite \
  "select value from journal_meta where key='build_fingerprint';"
sqlite3 data/runs.sqlite \
  "select stage, status, count(*) from unit_status group by stage, status;"
```

The manifest hash and both fingerprint values must match. Then restart OpenCode
so the plugin loads the pinned code, and run `knowdit_kg_status`.

## 5. Resume

```text
knowdit_kg_build
```

Do not pass `resetAll`, `force`, or a new `resetReason`. Do not change the model
or effort variant. Done units are skipped, interrupted units are retried, and
completed LLM calls are reused from the cache.

To continue in controlled batches instead, pass only the next contests:

```json
{ "c4Ids": [316, 331, 326] }
```

The global link pass processes findings without a `finding_link_status` row, so
it repairs the new batch without relinking the completed ones.

## Checkpoint policy

- Pilot one contest first to validate quality.
- After the pilot, build in batches of two or three contests.
- Snapshot after every batch; do not wait for a quota exhaustion.
- Keep exactly one machine as the writer. Do not build on both machines against
  the same state.
- Changing computers preserves progress; it does not reset an account quota.

## Failure modes

| Symptom | Action |
| --- | --- |
| Fingerprint mismatch | Restore the exact commit, dataset manifest, model, and window. If that is impossible, `reset_all` and rebuild; never edit `journal_meta` by hand. |
| Manifest hash mismatch | The dataset was regenerated or copied incorrectly. Restore the original `data/dataset`. |
| Only `kg.sqlite` copied | Journal is missing; the build repeats. Copy both databases. |
| Only `runs.sqlite` copied | Journal points at missing rows; copy the matching KG. |
| Stale `-wal` / `-shm` files | Remove them before copying restored databases. |
| Quota exhausted mid-stage | Resume the same build. Completed units and cached responses are retained. |
| Two writers | Stop both, keep one state as authoritative, restore it on both, and continue on one machine only. |

## What not to copy

`data/tmp/`, `data/llm-scratch/`, and `data/progress.log` are scratch and
diagnostics. Skip them. Copy `dataset`, `cache`, `kg.sqlite`, and `runs.sqlite`
only.
