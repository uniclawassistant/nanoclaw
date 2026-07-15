const DEFAULT_MAX_INVALIDATED_SESSION_IDS = 1000;

/**
 * Prevents a container that is finishing after mode=new from restoring the
 * session ID that the reset just deleted. IDs are UUIDs and globally unique,
 * so a bounded process-wide set is sufficient across all groups.
 */
export class SessionInvalidationFence {
  private readonly invalidated = new Set<string>();

  constructor(
    private readonly maxSize: number = DEFAULT_MAX_INVALIDATED_SESSION_IDS,
  ) {}

  invalidate(sessionId: string | undefined): void {
    if (!sessionId) return;
    this.invalidated.delete(sessionId);
    this.invalidated.add(sessionId);

    while (this.invalidated.size > this.maxSize) {
      const oldest = this.invalidated.values().next().value as
        | string
        | undefined;
      if (!oldest) break;
      this.invalidated.delete(oldest);
    }
  }

  canPersist(sessionId: string): boolean {
    return !this.invalidated.has(sessionId);
  }
}
