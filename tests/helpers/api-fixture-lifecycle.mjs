export class ApiFixtureLifecycle {
  #closing = false;
  /** @type {Set<Promise<void>>} */
  #pending = new Set();

  /**
   * @param {string} label
   * @param {AbortSignal} signal
   */
  constructor(label, signal) {
    this.label = label;
    this.signal = signal;
    this.stop = () => { this.#closing = true; };
    signal.addEventListener('abort', this.stop, { once: true });
    if (signal.aborted) this.stop();
  }

  get pending() { return this.#pending.size; }

  assertOpen() {
    if (this.#closing || this.signal.aborted) {
      throw new Error(`API fixture has finished or timed out; no subsequent operation is authorized: ${this.label}`);
    }
  }

  /**
   * @template T
   * @param {() => Promise<T>} operation
   * @returns {Promise<T>}
   */
  run(operation) {
    this.assertOpen();
    const work = Promise.resolve().then(() => {
      this.assertOpen();
      return operation();
    });
    const settled = work.then(
      () => { this.#pending.delete(settled); },
      () => { this.#pending.delete(settled); }
    );
    this.#pending.add(settled);
    return work.then((value) => {
      this.assertOpen();
      return value;
    });
  }

  /** @param {number} timeoutMs */
  async drain(timeoutMs) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new RangeError('Fixture drain requires a positive finite millisecond budget');
    this.stop();
    this.signal.removeEventListener('abort', this.stop);
    if (!this.#pending.size) return;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    try {
      await Promise.race([
        Promise.all([...this.#pending]),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`API fixture drain exceeded its budget; retain the registered scope: ${this.label}`)), timeoutMs);
        })
      ]);
    } finally { if (timer) clearTimeout(timer); }
  }
}
