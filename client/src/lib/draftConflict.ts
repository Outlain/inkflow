/**
 * Merge conflict resolution between local drafts and remote state.
 * A dirty local draft wins when it has a higher revision or a newer timestamp.
 */

export interface DraftComparison {
  draftDirty: boolean;
  draftRevision: number;
  draftUpdatedAt: string;
  remoteRevision: number;
  remoteUpdatedAt: string;
}

export function shouldUseDraft(input: DraftComparison): boolean {
  if (!input.draftDirty) {
    return false;
  }

  if (input.draftRevision > input.remoteRevision) {
    return true;
  }

  return input.draftUpdatedAt >= input.remoteUpdatedAt;
}
