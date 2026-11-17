---
name: branch-workflow
description: Use whenever adding a feature or fixing a bug in OneChat. Creates a feature/ or fix/ branch and does the work there instead of on main.
---

# Branch workflow

Never commit new features or fixes directly to `main`.

1. Check `git status` and the current branch. If on `main`, make sure it is up to date (`git pull --ff-only`).
2. Create a branch before editing anything:
   - New functionality or changes: `git switch -c feature/<short-kebab-name>`
   - Bug fixes: `git switch -c fix/<short-kebab-name>`
3. Do the work and commit on that branch. Push it with `git push -u origin <branch>`.
4. Merge into `main` only when the user explicitly asks (e.g. "merge it"). Then merge, push `main`, and mention that the branch can be deleted.
5. If already on a feature/fix branch for the same task, keep using it; start a new branch for unrelated work.
6. Pushing a `feature/**` or `fix/**` branch deploys it to the public GitHub Pages site (see `.github/workflows/pages.yml`), so push after each change the user should see. Merging to `main` redeploys `main`.
