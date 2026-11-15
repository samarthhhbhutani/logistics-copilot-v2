/**
 * `Promise.all(items.map(work))` with at most `concurrency` calls of `work` in flight. Results keep
 * the order of `items`; a rejection ends the batch like Promise.all does, so callers that must go
 * on past failures catch inside `work`. Hand-rolled because p-limit cannot be hoisted next to the
 * older copy eslint brings, and a nested copy is not shipped in the API image.
 */
export async function mapWithConcurrency<Item, Result>(
  items: readonly Item[],
  concurrency: number,
  work: (item: Item, index: number) => Promise<Result>,
): Promise<Result[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError(`concurrency must be a positive integer, got ${concurrency}`);
  }
  const results: Result[] = new Array<Result>(items.length);
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await work(items[index] as Item, index);
    }
  }
  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
