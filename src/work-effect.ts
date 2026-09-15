const revisions = new Map<string, number>();

export function getWorkEffectRevision(groupFolder: string): number {
  return revisions.get(groupFolder) ?? 0;
}

export function recordWorkEffect(groupFolder: string): void {
  revisions.set(groupFolder, getWorkEffectRevision(groupFolder) + 1);
}
