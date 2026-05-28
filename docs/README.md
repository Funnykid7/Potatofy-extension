# Potatofy site

This folder is the marketing site published on GitHub Pages. The actual
extension source lives at the repo root.

## Deploy

Settings -> Pages -> Source: **Deploy from a branch** -> Branch: `main`
-> Folder: `/docs` -> Save.

After the first deploy finishes, the site is live at
`https://<owner>.github.io/Potatofy-extension/`.

## Stack

Vanilla HTML, CSS, and a small JS file. No build step, no `node_modules`,
no external fonts, no analytics. The site embodies the same philosophy as
the extension: ship only what the page needs.

## Files

- `index.html` - all sections
- `styles.css` - single stylesheet
- `script.js` - copy-to-clipboard, scroll reveal, smooth nav
- `assets/` - icons and favicon

## Editing

Open `index.html` directly in a browser to preview. Changes are live on
GitHub Pages a minute or two after pushing to `main`.
