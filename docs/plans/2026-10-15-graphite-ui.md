# Graphite Blue UI Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Apply the approved left-hand graphite-blue concept to all ten Sliceman pages and overlays, delivering an unpacked UXP Developer Tools build only.

**Architecture:** Retain DOM IDs, Photoshop actions, preferences, masking and scroll-lock behavior. Restyle the shared CSS, replace navigation SVGs with consistent line icons, refine page headings and rename previews. Keep literal CSS colors and flex layouts for UXP compatibility.

**Tech Stack:** HTML, UXP CSS, JavaScript, esbuild, Vitest; browser rendering for layout QA, Photoshop for final host verification.

## Approved design

- Graphite #24262b canvas; #1d1f23 navigation; #30333a fields; #42464e borders; #6b96f8 accents; #e7e8eb primary and #969ca7 secondary text.
- 54px navigation, compact 44px header, 36px main actions, 6px control radii. Flat sections replace nested framed cards. Preserve actual rename modes and `n` syntax (the concept's `{n}` was illustrative).
- All ten destinations, all resize steps, dropdowns, hints, history/preset/search/settings dialogs, disabled/running/error states are in scope.
- Keep the current custom-button compatibility fix. Do not install, publish, or create a new CCX.

## Task 1 — Shared visual system

Files: `src/ui/styles.css`, `src/ui/index.html`.
1. Replace the navy/cyan palette consistently, retaining semantic red/amber/green and user color swatches.
2. Update shell, navigation icons, header, controls, typography, sections and overlays in the existing rules, preserving UXP workarounds.
3. Preserve all IDs and data attributes; add concise page descriptions and move settings to header.
4. Update obsolete UI contract assertions when their intended layout changes; run `npm test -- tests/ui-ids.test.js tests/custom-button.test.js`.

## Task 2 — Rename preview hierarchy

Files: `src/ui/panel.js`, `src/ui/index.html`, `src/ui/styles.css`, `tests/panel-smoke.test.js`.
1. Add behavior tests for selection count and column previews, including escaped names and unmatched/duplicate states.
2. Run focused tests to observe failures.
3. Render existing computed rename data as old/new columns without changing rename semantics.
4. Run the targeted tests and inspect empty and populated previews.

## Task 3 — Verify and deliver

Files: `dist/plugin/*` (generated), `docs/uxp-graphite-testing.md`, browser QA artifacts under `dist/ui-review/`.
1. Build with `npm run build`; run the complete Vitest suite.
2. Render actual HTML/CSS with browser-only sample data; inspect all pages and overlays at 300/340/420px widths. Clearly distinguish browser QA from Photoshop host verification.
3. Request code review; address actionable issues and rerun affected checks.
4. Document Add Plugin → `dist/uxp-dev/manifest.json` → Load/Reload, and the Photoshop checks to perform. A `build:dev` target gives the preview a separate plugin/panel identity so the installed release can remain available. Source release identity and version stay unchanged; no automatic installation or CCX.
