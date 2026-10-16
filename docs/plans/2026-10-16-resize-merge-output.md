# Merge resize output and processing

**Goal:** Three steps: source, size, output and processing. Keep all output options, validation, progress, stop, logs and completion actions.

**Architecture:** Place output settings and execution cards under pane 3; remove pane/step 4. Update the existing step count and navigation. Hide editable output settings while running and restore them afterwards. Invalidate completed status immediately when settings change on the merged page, refresh summaries, and avoid overwriting processing status with filename examples.

**Validation:** Test direct execution on step 3, backwards navigation, validation routing, settings changes after completion, and stop/progress behavior. Update old four-step tests. Run regression checks and build the UDT development directory only.
