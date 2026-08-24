export class TurnBoundary {
  private pending = true;

  markActivity(): void {
    this.pending = true;
  }

  async handleObserved(handler: () => Promise<void>): Promise<void> {
    await handler();
    this.pending = false;
  }

  async handlePending(handler: () => Promise<void>): Promise<void> {
    if (!this.pending) return;
    await this.handleObserved(handler);
  }

  isPending(): boolean {
    return this.pending;
  }
}
