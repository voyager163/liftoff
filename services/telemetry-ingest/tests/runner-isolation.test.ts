import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const now = () => new Date(0);
const clock = { now };

describe('service test runner isolation', () => {
  beforeEach(() => {
    expect(clock.now).toBe(now);
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  // Leave each spy in place so the next case verifies the runner restores it.
  it.each([1, 2])('restores the original clock before case %i', () => {
    const spy = vi.spyOn(clock, 'now').mockReturnValue(new Date(1));

    expect(clock.now()).toEqual(new Date(1));
    expect(spy).toHaveBeenCalledOnce();
  });
});
