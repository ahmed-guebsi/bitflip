# BitFlip

The datasheet for **Madou's Microverse** — nine overengineered builds specified like
silicon, every claim shipped with the capture that proves it.

**Live:** https://ahmed-guebsi.github.io/bitflip/

---

## What this is

A single-page site built as a literal semiconductor datasheet. Each episode is a
**PART** (`V01`–`V09`) with its own sheet: pin configuration, method, firmware
excerpt, commit hash, safety notice, two instrument captures and a verdict.

The doctrine it is built to enforce:

| | |
|---|---|
| LAW 01 | Every build must teach a nameable skill |
| LAW 02 | No cloud. Nothing phones home. |
| LAW 03 | The fire extinguisher is a cast member |
| LAW 04 | Never fake a fail |
| LAW 05 | The scope trace is the receipt |
| LAW 06 | A verdict withheld beats a verdict guessed |

## Architecture

Zero dependencies, zero build tooling. No npm, no bundler, no server.

| File | Role |
|---|---|
| `Madous Microverse.dc.html` | Entry document — markup, styles and component logic. Source of truth. |
| `support.js` | Vendored design-component runtime (loads React 18 from CDN at runtime) |
| `hardware.js` | `<hw-board>` — three.js studio renders of the ESP32 DevKit and Raspberry Pi 5 |
| `plots.js` | `<scope-plot>` — instrument captures drawn to canvas from deterministic data |
| `anim.js` | Scroll-linked entrances, counters, the WS2812B progress rail |

Fonts come from Google Fonts; three.js and React from unpkg. Nothing else is fetched,
and the page makes no outbound requests of its own.

## Local development

No install step. Serve the directory over HTTP (`file://` will not work — the runtime
fetches its own modules):

```bash
python -m http.server 8000
```

Then open http://127.0.0.1:8000/Madous%20Microverse.dc.html

## Deployment

Pushes to `main` publish to GitHub Pages via
[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml). CI stages a clean
`_site/`, copies the canvas document to `index.html` so Pages can serve the root URL,
verifies every local asset reference resolves, then deploys.

No secrets are required — the workflow authenticates with the automatic `GITHUB_TOKEN`.

## Licence

Firmware and hardware referenced by the sheets: MIT / CERN-OHL-S.
