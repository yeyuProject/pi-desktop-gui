/** Owns the two independent queues and the counts used by quit, reload and workspace checks. */
export class AgentOperations {
  private operation = Promise.resolve();
  private preferences = Promise.resolve();
  private pendingCount = 0;
  private readingCount = 0;
  private preferringCount = 0;
  get pending() {
    return this.pendingCount;
  }
  get reading() {
    return this.readingCount;
  }
  get preferring() {
    return this.preferringCount;
  }

  run<T>(action: () => Promise<T>): Promise<T> {
    this.pendingCount++;
    const result = this.operation.then(action, action);
    this.operation = result.then(
      () => {},
      () => {},
    );
    return result.finally(() => {
      this.pendingCount--;
    });
  }

  prefer<T>(action: () => Promise<T>, idle: () => void): Promise<T> {
    this.preferringCount++;
    this.pendingCount++;
    const result = this.preferences.then(action, action);
    this.preferences = result.then(
      () => {},
      () => {},
    );
    return result.finally(() => {
      this.pendingCount--;
      this.preferringCount--;
      if (!this.preferringCount) idle();
    });
  }

  async read<T>(action: () => Promise<T>, idle: () => void): Promise<T> {
    this.readingCount++;
    this.pendingCount++;
    try {
      return await action();
    } finally {
      this.readingCount--;
      this.pendingCount--;
      if (!this.readingCount) idle();
    }
  }

  async drain() {
    await this.preferences;
    await this.operation;
  }
}
