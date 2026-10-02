# Notes for Claude

## Before starting any work

- **Fetch and start from the latest `main` on GitHub.** Run `git fetch origin main` and
  branch from `origin/main`, not from the local `main`, which can be many commits
  behind in a fresh container. Check the version in `package.json` against the one on
  GitHub before auditing, reviewing or changing anything. (An audit of the menus was
  once done on v0.1.57 while GitHub was on v0.1.71, and had to be redone.)
- If a working branch already exists on GitHub, check whether it is behind
  `origin/main` before building on it.

## Working on GitHub issues

- When starting work on a GitHub issue, assign it and add the `in progress` label;
  remove the label when the fix is pushed.

## Every commit

- Add an entry to the top of `changelog.html` (the first `<article>` inside `<main>`)
  in the same commit. The pre-commit hook bumps the patch version, so the entry is
  for the version `package.json` will have after the commit: one more than it says
  now. Check `origin/main` first, since another commit landing there first changes
  the number. Copy the shape of the entry below it: the version as the article's
  `id` and link, the date in `<time>`, the change in the `<h2>`, then a `<ul>` of a
  few short bullets written for the player, not about the code. Escape `&` and `<`,
  and link issue numbers as the others are. Changes only to docs, tests or tooling
  still get an entry with just the `<h2>`.
- If you merge `main` into a branch, the version moves on. Renumber the branch's
  changelog entry to match.

## Checking the front end

- Look at every screen at Xbox 1080p (an Xbox user agent turns the TV layout on),
  Steam Deck 1280x800, and a phone upright and sideways. Check for controls off the
  screen and for screens that scroll.
- The TV layout zooms the overlay 1.4x, but media queries still see the real
  viewport, so rules keyed on `max-height` never fire on a TV. Give the TV layout
  its own `body.tv` rules.
