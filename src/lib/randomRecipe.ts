/** One id from `ids`, never `previous` unless it is the only one. `ids` must not be empty. */
export function pickRandom(
  ids: readonly string[],
  previous?: string,
  random: () => number = Math.random,
): string {
  const choices = ids.length > 1 ? ids.filter((id) => id !== previous) : ids;
  return choices[Math.floor(random() * choices.length)];
}
