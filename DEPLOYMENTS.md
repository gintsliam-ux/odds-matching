# Deployments

This repo (`odds-matching`) backs two Vercel projects. Both deploy from Git, and
both redeploy on every push to `main`.

| project | deploys from | root dir | serves |
|---|---|---|---|
| `sports-odds-desk` | push to `main` (other branches get previews) | `arb-tracker-mongo` | `sports-odds-desk.vercel.app` |
| `workspace` | push to `main` (other branches get previews) | repo root | `odds-matching.vercel.app` |

Checked against the Vercel team and GitHub on 27 Nov 2026.

## What a push to `main` does

- Both projects build and go public. There is no ignored-build step on either,
  so a change to one folder redeploys both sites, and so does a docs-only commit.
- The `mapping-tick` workflow is read from `main`, so workflow changes must land
  there.

## Projects that no longer exist

- **`arb-tracker`** was deleted from the Vercel team. It used to build every
  branch with root directory `arb-tracker/`, which only exists on the
  `arb-tracker` branch, so every `main` commit produced a failed build and an
  email. No commit on `main` since 30 Oct 2026 carries an `arb-tracker` build.
  The `arb-tracker` branch is still in the repo but nothing deploys it. A local
  `arb-tracker/` folder, where present, is a separate ignored checkout.
- **`live-fixtures`** was removed from `main` on 30 Oct 2026 (`5447d2a`) and has
  no Vercel project. It cannot be deployed.

The old advice to batch work into one PR per session, to limit failed
`arb-tracker` builds, no longer applies.

## Other projects on the same Vercel team

These build from their own repos, not this one: `wagering-co` (repo `swiftbet`),
`racing-flucs`, `polytracker`, `next-to-go` (`racing-odds-desk.vercel.app`) and
`margin-dashboard`.
