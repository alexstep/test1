/**
 * In-memory secret store - secrets never written back to process.env.
 * process.env is inherited by child processes and often appears in crash dumps,
 * APM snapshots, and debug output; a private Map limits post-bootstrap leakage.
 */
const store = new Map<string, string>();

export const secretsStore = {
  get(name: string): string | undefined {
    return store.get(name);
  },

  set(name: string, value: string): void {
    store.set(name, value);
  },

  has(name: string): boolean {
    return store.has(name);
  },

  getRequired(name: string): string {
    const value = store.get(name);
    if (value === undefined) {
      throw new Error(`${name} is required`);
    }
    return value;
  },

  listNames(): string[] {
    return [...store.keys()];
  },

  /** @internal test helper */
  clearForTests(): void {
    store.clear();
  },
};
