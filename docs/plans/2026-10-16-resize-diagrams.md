# Resize rule diagrams implementation plan

**Goal:** Add the approved left-aligned illustrations for eight resize rules and all four fixed-width/height fit modes, and rename the rule label to 尺寸规则.

**Architecture:** A pure presentation selector returns inline SVG and a concise example caption. Existing resize calculations remain unchanged. The existing mode-sync path updates the illustration and preserves conditional anchor visibility. SVG uses basic shapes, not image elements or generated-image mockups, consistent with the existing UXP rendering approach.

**Tech Stack:** JavaScript, SVG, HTML/CSS, Vitest, esbuild, Photoshop UXP.

1. Test selection across eight rules and four fits, including irrelevant fit values and anchor visibility.
2. Add eleven explanatory SVGs (four fixed-box states and seven other rules), with fixed left-aligned display bounds and descriptive alternative text.
3. Place illustration to the left of the existing anchor block. Hide anchors for unsupported combinations and update on rule/fit changes and preset restore.
4. Run targeted and existing UI tests, build the UDT development directory, and inspect layout. Do not package or publish.
