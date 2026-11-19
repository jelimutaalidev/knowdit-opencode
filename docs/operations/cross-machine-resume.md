# Cross-machine build resume

Use this when a `knowdit_kg_build` is **already in progress** and must continue
on another computer. For a fresh start, see `AGENTS.md` §13 instead.

Resume is defined by build state, not by the repository. The code, dataset
manifest, KG, journal, cache, model, and context window must all be the same
identity. Mixing any of them is refused by the journal fingerprint.

The scripts in this guide implement that rule: they capture a verified,
self-contained bundle and refuse to restore a bundle that does not match the
checkout or the pipeline version.

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

## What a bundle contains

```
identity.json     commit, pipeline version, dataset hashes, journal state, artifact hashes
kg.sqlite         consistent copy (VACUUM INTO), no WAL/SHM files
runs.sqlite       consistent copy (VACUUM INTO), no WAL/SHM files
dataset/          exact snapshot including manifest.json
cache/            LLM response cache (omit only with --no-cache)
```

The dataset is small (about 3 MB for the 12-contest generation), so it travels
inside the bundle. A single bundle is self-contained; there is no separate
dataset download or Git LFS step.

`data/tmp/`, `data/llm-scratch/`, and `data/progress.log` are **not** included.

## 1. Pin the code

The build identity includes the **commit**, so tag the exact commit you start
from, not just the pipeline version:

```bash
git tag -a phase1-build-<date> -m "Phase 1 build start"
git push origin phase1-build-<date>
```

`phase1-p0p1.4` is the pipeline checkpoint tag, but a build may start from a
later commit (tooling or documentation changes do not alter the KG). Resume must
check out the commit recorded in `identity.json`; restore refuses a mismatch.

## 2. Snapshot on the current machine

Stop the build first. Do not reset, do not `dataset_prepare`.

```bash
npm run state:snapshot
# or choose a location explicitly:
npm run state:snapshot -- --out ~/knowdit-state/checkpoint-01
```

Without `--out`, the default is
`~/knowdit-state/fp-<fingerprint12>/<timestamp>/` (`nofp/` before the first
fingerprint is bound).

The script:

- copies both databases with `VACUUM INTO`, so WAL content is included and the
  output is a clean single file;
- copies `dataset/` and `cache/`;
- writes `identity.json` with commit, `PIPELINE_VERSION`, dataset manifest and
  tree hashes, journal fingerprint and unit counts, and KG/journal/cache hashes;
- refuses to run from a dirty worktree, over a running unit, or over an existing
  bundle, unless the matching flag is passed (`--allow-dirty`,
  `--allow-running`, `--force`);
- only replaces a directory that contains `identity.json`; any other directory
  is refused, and the output may not overlap `data/`.

`--allow-running` is **crash recovery only**. Never snapshot while the build
process is alive: the two databases are copied separately, so a live build could
leave the KG and journal at different points. Wait for the run to stop (a quota
error stops it cleanly).

Verify the printed summary: commit, pipeline version, fingerprint, unit counts,
and dataset hash.

## 3. Transfer the bundle

Over a private channel (SSH, private object storage, or a USB drive):

```bash
# direct
rsync -av --partial ~/knowdit-state/fp-<id>/<timestamp>/ \
  user@other-machine:~/knowdit-state/import/

# or via private object storage
rclone copy ~/knowdit-state/fp-<id>/<timestamp> remote:knowdit-state/fp-<id>/<timestamp>
rclone copy remote:knowdit-state/fp-<id>/<timestamp> ~/knowdit-state/import
```

A USB drive is a valid backup or offline seed, but it is still a copy of the
same bundle; do not copy `data/` directly while a build is running. Never commit
build state to the public repository.

## 4. Restore on the other machine

```bash
cd ~/knowdit-opencode
git fetch --all --tags
git checkout <build-tag-or-commit>
npm ci

npm run state:restore -- --from ~/knowdit-state/import
# add --force when the target already contains build state
```

Before touching the target, restore verifies the bundle's KG, journal, dataset,
and cache hashes against `identity.json`, then checks:

- the checked-out commit equals `identity.commit`;
- `PIPELINE_VERSION` equals `identity.pipelineVersion`;
- the bundle was not captured from a dirty worktree (unless `--allow-dirty`);
- the target worktree is clean (unless `--allow-dirty`).

If the target already has state and `--force` is given, the old
`kg.sqlite`, `runs.sqlite`, `dataset/`, and `cache/` are moved to
`data/.restore-backup-<timestamp>-<pid>/`, not deleted. `tmp/`, `llm-scratch/`,
and `progress.log` are left alone. A failure during the copy rolls the old state
back automatically.

Restart OpenCode after restoring so the plugin loads the pinned code.

## 5. Verify and resume

```bash
npm run state:snapshot -- --help    # flags and defaults
```

The restore summary prints the commit, pipeline version, fingerprint, and unit
counts. Then in OpenCode:

```text
knowdit_kg_status
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
- Keep at least the last two bundles; format changes are not backward compatible
  and a corrupted copy should not be the only copy.
- Changing computers preserves progress; it does not reset an account quota.

## Failure modes

| Symptom | Action |
| --- | --- |
| `bundle was created at commit …` | Check out the tag/commit named in the error. Do not rewrite `identity.json`. |
| `pipeline version … does not match` | The checkout is not the code that produced the bundle. Restore the matching commit. |
| `journal has N running unit(s)` | The build is alive or crashed. Stop it first; use `--allow-running` only after a crash. |
| `target already contains build state` | Re-run restore with `--force`; the previous state is backed up first. |
| `bundle … hash does not match identity.json` | The copy is incomplete or corrupted. Re-transfer from the source machine. |
| `refusing to replace …: it is not a snapshot bundle` | Pick a different `--out`. `--force` never deletes an unrelated directory. |
| `snapshot output must not overlap the data directory` | Put the bundle outside the repository, for example `~/knowdit-state`. |
| `worktree is dirty` | Commit or stash, or use `--allow-dirty` deliberately. A dirty bundle records `dirty: true` and needs the same flag on restore. |
| Fingerprint mismatch in the build | The model, window, dataset manifest, or pipeline version differs. Restore the matching identity; if impossible, `reset_all` and rebuild. Never edit `journal_meta` by hand. |
| Quota exhausted mid-stage | Resume the same build. Completed units and cached responses are retained. |
| Two writers | Stop both, keep one state as authoritative, restore it on both, and continue on one machine only. |

## Manual fallback

Use this only if Node cannot run the scripts. The steps are the same; the
scripts add hash verification and rollback.

```bash
set -euo pipefail
SNAP="$HOME/knowdit-state/manual-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$SNAP"

sqlite3 data/kg.sqlite   ".backup '$SNAP/kg.sqlite'"
sqlite3 data/runs.sqlite ".backup '$SNAP/runs.sqlite'"
cp -a data/dataset "$SNAP/dataset"
[ -d data/cache ] && cp -a data/cache "$SNAP/cache"

sha256sum data/dataset/manifest.json > "$SNAP/manifest.sha256"
sqlite3 data/runs.sqlite \
  "select value from journal_meta where key='build_fingerprint';" \
  > "$SNAP/fingerprint.txt"
```

Restore by removing the target `kg.sqlite`, `runs.sqlite`, `dataset/`, and
`cache/` (including stale `-wal`/`-shm`), copying the bundle in, and comparing
`sha256sum -c manifest.sha256` plus both fingerprint values before resuming.

## What not to copy

`data/tmp/`, `data/llm-scratch/`, and `data/progress.log` are scratch and
diagnostics. Copy `dataset`, `cache`, `kg.sqlite`, and `runs.sqlite` only.
