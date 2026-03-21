# Inkflow Performance Budgets

## Purpose

These budgets are the acceptance targets for the rebuild. They are intentionally biased toward smoothness and stability over minimal CPU or RAM usage.

## Test Assets

Primary baseline asset:

- anonymized baseline textbook PDF
- `46 MB`
- `875 pages`

Primary stress asset:

- anonymized stress textbook PDF
- `191 MB`
- `1620 pages`

Secondary stress asset:

- anonymized extended stress PDF
- `117 MB`
- `2390 pages`

## Core Budgets

### Phase 1

- App boot to healthy server: under `5s` on a warm local Docker build.
- Data directory bootstrap: under `250ms`.
- Notebook creation API: under `100ms`.
- PDF import request accepted: under `250ms` before background work completes.
- Metadata extraction for first page count and dimensions:
  - baseline PDF: under `5s`
  - stress PDF: under `20s`

### Phase 2

- Shell size change after mount: `0`.
- Layout shift count in the main reader during first open: `0`.
- Mixed-size page flashes in the main reader: `0`.
- Visible range recalculation during scroll: under `4ms` scripting budget per frame on typical desktop hardware.

### Phase 3

- First open network payload for a large PDF document session should exclude heavy preview data and remain under `1.5 MB`.
- Main-thread scripting during active scroll should avoid sustained tasks above `8ms`.
- Visible page render queue should cap at:
  - current visible pages
  - plus at most `1` neighbor page above and below
- While active scrolling is detected:
  - full-page background pre-render: `paused`
  - thumbnail generation: allowed only if idle/cancelable
- Thumbnail generation:
  - first requested thumbnail under `1500ms`
  - subsequent cached thumbnail fetch under `150ms`
- Search request over stress asset:
  - first indexed query under `1200ms`
  - warm query under `300ms`

### Phase 4

- Pointer input pipeline should not miss fast tap-dots or very short strokes in manual iPad testing.
- No input event loss caused by save or render queue contention.
- No finger-scroll lockout while stylus-only writing is enabled.
- No unexpected browser text selection or callout artifacts on the writing surface.

### Phase 5

- Local draft enqueue after stroke end: under `50ms`.
- Background save must not block pointer processing.
- WebSocket apply on clean page: under `50ms`.
- Remote update applied to dirty page: `0` destructive overwrites.

### Phase 6 to 8

- Structural page insert/delete transaction:
  - typical local operation under `150ms`
  - large rebalance under `2000ms`, infrequent and instrumented
- Bookmark set/jump: under `100ms`
- Merged annotated export:
  - baseline PDF under `15s`
  - stress PDF under `90s`

## Resource Assumptions

Target deployment assumptions for a comfortable self-hosted install:

- `2` vCPU minimum
- `4 GB` RAM minimum
- SSD-backed persistent storage preferred

Preferred for very large textbook workloads:

- `4` vCPU
- `8 GB` RAM

## Performance Policies

- Smoothness wins over aggressive precomputation.
- Blank fixed-size shells are preferred over unstable preview swaps.
- Background work must be cancelable.
- Range requests and linearized PDFs are preferred for large imports and random access.
- Thumbnail and full-page rendering stay on separate queues.
- Search is server-side for large documents.

## Instrumentation Requirements

Budgets must be verified with instrumentation, not guesswork.

Required measurements:

- shell dimension hash before and after mount
- active page and visible range changes
- render queue length
- render duration per page
- scroll active vs idle windows
- save queue latency
- draft persistence latency
- import stage timings
- preview generation timings
- search query timings

## Remaining Validation Gaps

- Physical iPad Safari measurements have not been captured in this environment.
- Physical Apple Pencil measurements have not been captured in this environment.
- Frame-budget claims for scroll and inking remain partially design-backed until hardware QA is run.

## Measured Snapshot on 2026-03-20

Collected from the current production build against local test assets:

- Stress import (`191 MB`, `1620` pages): `31.65s`
- Baseline import (`46 MB`, `875` pages): `11.95s`
- Stress search query (`physics`): `203ms`
- Baseline search query (`calculus`): `22.72ms`
- Stress deep-page preview generation: `1.08s`
- Stress byte-range response setup: `2.43ms`
- Stress blank-page insert: `45.44ms`
- Stress insert-PDF-pages: `1.64s`
- Stress annotated export after structural edits: `2.43s`

Interpretation:

- Import times are above the early optimistic Phase 1 metadata-extraction targets, but the complete import pipeline includes copy, linearization, metadata extraction, preview readiness, page row creation, and text extraction/indexing.
- Search, insert, preview, and export are currently within comfortable bounds for the stated budgets.
- Physical iPad Safari scroll and Pencil measurements remain blocked on device availability, so frame-budget claims for those gates are still design-backed rather than directly measured on hardware.
