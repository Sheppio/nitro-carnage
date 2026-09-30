# Notes for Claude

## Before starting any work

- **Fetch and start from the latest `main` on GitHub.** Run `git fetch origin main` and
  branch from `origin/main`, not from the local `main`, which can be many commits
  behind in a fresh container. Check the version in `package.json` against the one on
  GitHub before auditing, reviewing or changing anything. (An audit of the menus was
  once done on v0.1.57 while GitHub was on v0.1.71, and had to be redone.)
- If a working branch already exists on GitHub, check whether it is behind
  `origin/main` before building on it.

## Checking the front end

- Look at every screen at Xbox 1080p (an Xbox user agent turns the TV layout on),
  Steam Deck 1280x800, and a phone upright and sideways. Check for controls off the
  screen and for screens that scroll.
- The TV layout zooms the overlay 1.4x, but media queries still see the real
  viewport, so rules keyed on `max-height` never fire on a TV. Give the TV layout
  its own `body.tv` rules.
