/**
 * Picks which of `count` loading animations to show: uniformly at random,
 * but never `previous` again when there is another to choose, so two imports
 * in a row never play the same one.
 */
export function pickAnimationIndex(
  count: number,
  previous: number | null,
  random: () => number = Math.random,
): number {
  if (count <= 1) return 0;
  if (previous === null || previous < 0 || previous >= count) {
    return Math.min(count - 1, Math.floor(random() * count));
  }
  const i = Math.min(count - 2, Math.floor(random() * (count - 1)));
  return i >= previous ? i + 1 : i;
}
