import { describe, expect, it } from 'vitest';
import { shouldUseDraft } from './draftConflict';

describe('shouldUseDraft', () => {
  it('prefers a dirty draft with a newer revision', () => {
    expect(
      shouldUseDraft({
        draftDirty: true,
        draftRevision: 3,
        draftUpdatedAt: '2026-03-20T12:00:00.000Z',
        remoteRevision: 2,
        remoteUpdatedAt: '2026-03-20T12:01:00.000Z'
      })
    ).toBe(true);
  });

  it('prefers a dirty draft with a newer timestamp when revisions tie', () => {
    expect(
      shouldUseDraft({
        draftDirty: true,
        draftRevision: 2,
        draftUpdatedAt: '2026-03-20T12:02:00.000Z',
        remoteRevision: 2,
        remoteUpdatedAt: '2026-03-20T12:01:00.000Z'
      })
    ).toBe(true);
  });

  it('rejects stale or clean drafts', () => {
    expect(
      shouldUseDraft({
        draftDirty: false,
        draftRevision: 5,
        draftUpdatedAt: '2026-03-20T12:03:00.000Z',
        remoteRevision: 1,
        remoteUpdatedAt: '2026-03-20T12:00:00.000Z'
      })
    ).toBe(false);

    expect(
      shouldUseDraft({
        draftDirty: true,
        draftRevision: 1,
        draftUpdatedAt: '2026-03-20T12:00:00.000Z',
        remoteRevision: 2,
        remoteUpdatedAt: '2026-03-20T12:01:00.000Z'
      })
    ).toBe(false);
  });
});
