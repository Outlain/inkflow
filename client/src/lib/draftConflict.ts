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
