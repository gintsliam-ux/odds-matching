# Deployments

This repo backs several Vercel projects. They do **not** all deploy the same way,
which is the source of a recurring surprise — write it down once.

| project | deploys from | root dir | notes |
|---|---|---|---|
| `live-fixtures` | **CLI only** (`vercel --prod`) | `live-fixtures` | no Git integration — merging to `main` does NOT deploy it |
| `arb-tracker` | push to the `arb-tracker` branch | `arb-tracker` | production branch is `arb-tracker`, not `main` |
| `workspace` | push to any branch | repo root | serves `odds-matching.vercel.app` |

## Known: arb-tracker fails on every `main` commit

Every commit that lands on `main` triggers an `arb-tracker` build that dies in
~350 ms with:

```
Cloning odds-matching (Branch: main, Commit: …)
The specified Root Directory "arb-tracker" does not exist.
```

`arb-tracker/` only exists on the `arb-tracker` branch, but the project is
configured to build **all** branches. Each failure emails the account owner, and
a single PR produces two (one per environment).

**Things that do not fix it:**

- The Ignored Build Step. `commandForIgnoringBuildStep` is already set to
  `git diff --quiet HEAD^ HEAD -- ./`, but Vercel resolves the root directory
  *before* running it, so it never executes.
- `vercel.json` with `git.deploymentEnabled`. That file is read from the
  project's root directory — `arb-tracker/` — which is the thing that's missing.
  Same circularity.
- The Vercel CLI. `vercel git` only offers `connect` / `disconnect`.

**The fix** is one project setting:

> arb-tracker → Settings → Git → Deployment Branches → **Only the Production Branch**

The API alternative, `gitProviderOptions.createDeployments: "disabled"`, is worse
— it stops arb-tracker auto-deploying from its own branch too.

## Until then

Batch live-fixtures work into **one PR per session** rather than one per fix.
`main` stays the source of truth (and the mapping-tick workflow is read from it,
so workflow changes must land there), but 18 small PRs cost ~36 failed builds
where 3 would have cost 6.
