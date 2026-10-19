# Independent UXP local edition implementation plan

Final delivery amendments: the panel title is Sliceman, the package is Sliceman_Setup_v1.4.5.zip, and Chinese EXE launchers replace BAT entry points. The uninstall page requires a confirmation click without numeric input. Photoshop exit waiting and cancellation happen in the GUI; the transaction script retains its running-host checks. Original source and Creative Cloud artifacts remain unchanged.

**Goal:** Deliver a Windows one-click local installer with the same Sliceman features, without changing existing source, build scripts, or CCX artifacts.

**Architecture:** Build directly from existing source into standalone/release using a separate manifest identity (com.sliceman.plugin.local). A PowerShell installer stages files, backs up UXP metadata and previous local payloads, registers only this ID, and rolls back failed mutations. No Creative Cloud or Node.js is needed on the recipient machine. This follows the existing project's local registration mechanism; Adobe host compatibility requires a Photoshop smoke test.

**Tech Stack:** Existing esbuild, Windows PowerShell 5.1, Node built-in test runner.

## Tasks
1. Capture hashes of original source/scripts/artifacts. Add installer integration tests under standalone/tests; verify they fail before implementation.
2. Add standalone/build.mjs: compile existing entry point independently, supply local manifest to both bundle and output, copy static resources, copy installer/README/BAT launchers, package a ZIP. Never invoke the original build or write dist.
3. Add standalone/install.ps1 and BAT launchers: reject running Photoshop, invalid metadata, wrong identity and redirected paths; support first install, reinstall/upgrade and uninstall; keep backups and preserve unrelated metadata. Sandbox tests must be restricted to temporary test directories.
4. Exercise installation, reinstall, upgrade, uninstall, malformed metadata, wrong identity, missing payload, redirected paths, and rollback in temporary directories. Verify ZIP contents and original hashes. Run existing tests once.
5. Deliver the ZIP and extracted installer directory. Explain that actual Photoshop loading is unverified unless tested in the host. Do not close the user's running Photoshop or install into their profile automatically.

## Accepted design
User approved the independent UXP local edition on 2026-10-19. Panel title: Sliceman 本地版. Source remains shared read-only; identity and packaging are separate. Existing update UI remains identical: CCX downloads target the original edition, so local edition upgrades use a new local ZIP and its installer.
