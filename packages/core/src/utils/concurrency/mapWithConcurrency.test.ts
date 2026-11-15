import { describe, expect, it } from 'vitest';
import { mapWithConcurrency } from './mapWithConcurrency.js';

/** Let every queued microtask and the next macrotask run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('mapWithConcurrency', () => {
  it('runs at most `concurrency` works at once, starts the next as one finishes, and keeps item order', async () => {
    const finishers: (() => void)[] = [];
    const resultsPromise = mapWithConcurrency(
      [10, 20, 30, 40, 50],
      2,
      (item) => new Promise<number>((resolve) => finishers.push(() => resolve(item * 2))),
    );
    await settle();
    expect(finishers).toHaveLength(2);
    finishers[1]!();
    await settle();
    expect(finishers).toHaveLength(3);
    finishers[0]!();
    await settle();
    expect(finishers).toHaveLength(4);
    finishers[2]!();
    await settle();
    expect(finishers).toHaveLength(5);
    finishers[4]!();
    finishers[3]!();
    expect(await resultsPromise).toEqual([20, 40, 60, 80, 100]);
  });

  it('handles an empty list and a concurrency above the item count', async () => {
    expect(await mapWithConcurrency([], 3, async (item: number) => item)).toEqual([]);
    expect(await mapWithConcurrency([1, 2], 10, async (item) => item + 1)).toEqual([2, 3]);
  });

  it('rejects when a work rejects, like Promise.all', async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (item) => {
        if (item === 2) throw new Error('boom');
        return item;
      }),
    ).rejects.toThrow('boom');
  });

  it('refuses a non-positive or fractional concurrency', async () => {
    await expect(mapWithConcurrency([1], 0, async (item) => item)).rejects.toThrow(RangeError);
    await expect(mapWithConcurrency([1], 1.5, async (item) => item)).rejects.toThrow(RangeError);
  });
});
