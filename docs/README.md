# Inkflow Docs

This directory keeps non-essential project documentation organized by purpose so current guidance, troubleshooting notes, and archived validation snapshots do not compete with each other.

## Start Here

- [`../README.md`](../README.md) - project overview, setup, deployment, and runtime expectations
- [`architecture/system-overview.md`](./architecture/system-overview.md) - high-level architecture, module boundaries, and data model
- [`architecture/reader-internals.md`](./architecture/reader-internals.md) - reader loading, rendering, caching, and network behavior

## Current Guidance

- [`architecture/system-overview.md`](./architecture/system-overview.md) - primary system-design reference
- [`architecture/reader-internals.md`](./architecture/reader-internals.md) - reader-engine implementation notes
- [`operations/legacy-migration.md`](./operations/legacy-migration.md) - legacy import model, rewrite rules, and safety checks
- [`reference/performance-budgets.md`](./reference/performance-budgets.md) - acceptance targets and performance guardrails
- [`status/release-gates.md`](./status/release-gates.md) - current phase status plus the latest consolidated verification summary

## Troubleshooting And History

- [`troubleshooting/resolved-issue-history.md`](./troubleshooting/resolved-issue-history.md) - resolved bugs grouped by date, root cause, and fix
- [`archive/2026-03-20-verification-snapshot.md`](./archive/2026-03-20-verification-snapshot.md) - detailed dated verification record kept for historical reference
- [`../ios-wrapper/README.md`](../ios-wrapper/README.md) - subsystem-specific instructions for the optional iPad wrapper

## Maintenance Rules

- Keep active project guidance in the purpose-based folders above.
- Move dated snapshots, one-off validation logs, and superseded writeups into `archive/`.
- Keep subsystem-specific docs near the subsystem when that improves discoverability, as with `ios-wrapper/README.md`.
