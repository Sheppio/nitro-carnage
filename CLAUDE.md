# Notes for Claude

## Before starting any work

- **Fetch and start from the latest `main` on GitHub.** Run `git fetch origin main` and
  branch from `origin/main`, not from the local `main`, which can be many commits
  behind in a fresh container. Check the version in `package.json` against the one on
  GitHub before auditing, reviewing or changing anything. (An audit of the menus was
  once done on v0.1.57 while GitHub was on v0.1.71, and had to be redone.)
- If a working branch already exists on GitHub, check whether it is behind
  `origin/main` before building on it.

## Pushing

- **Always push finished work to `main`** as well as the working branch, without
  asking. Fetch `origin/main` first; if it has moved on, merge it in (and renumber
  the changelog entry) before pushing.

## Releasing

- `main` is development: Cloudflare builds a development copy from every push to it.
  `prod` is the live game: Cloudflare production builds only from `prod`.
- Never commit to `prod`, and only move it when the user asks for a release.
- A release fast-forwards `prod` to `main`: `git fetch origin main && git push origin
  origin/main:prod`. No merge commit and no new version: the live game gets exactly
  the build that was tested on `main`.

## Working on GitHub issues

- When starting work on a GitHub issue, assign it and add the `in progress` label;
  remove the label when the fix is pushed.

## Every commit

- Only commits that change the game (`index.html`, `css/`, `src/` or `dist/`) get a
  new version and a changelog entry. The pre-commit hook skips the bump for anything
  else, so commits that touch only docs, tests, tooling or the README (updating the
  test count, say) keep the current version and get no changelog entry.
- For a game change, add an entry to the top of `changelog.html` (the first
  `<article>` inside `<main>`) in the same commit. The pre-commit hook bumps the
  patch version, so the entry is for the version `package.json` will have after the
  commit: one more than it says now. Check `origin/main` first, since another commit
  landing there first changes the number. Copy the shape of the entry below it: the
  version as the article's `id` and link, the change in the
  `<h2>`, then a `<ul>` of a few short bullets written for the player, not about the
  code. Escape `&` and `<`. Leave out issue numbers and links to GitHub. The bullets
  cover only what changes in the game, never the changelog page itself, the docs or
  the tooling.
- If you merge `main` into a branch, the version moves on. Renumber the branch's
  changelog entry to match.

## Checking the front end

- Look at every screen at Xbox 1080p (an Xbox user agent turns the TV layout on),
  Steam Deck 1280x800, and a phone upright and sideways. Check for controls off the
  screen and for screens that scroll.
- The TV layout zooms the overlay 1.4x, but media queries still see the real
  viewport, so rules keyed on `max-height` never fire on a TV. Give the TV layout
  its own `body.tv` rules.
