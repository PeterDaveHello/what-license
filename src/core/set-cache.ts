const lowercaseSetCache = new WeakMap<
  Set<string>,
  { sourceValues: string[]; values: Set<string> }
>()

export function cachedSetSnapshotMatches(
  set: Set<string>,
  snapshot: string[],
): boolean {
  if (snapshot.length !== set.size) return false
  let index = 0
  for (const value of set) {
    if (snapshot[index] !== value) return false
    index += 1
  }
  return true
}

export function cachedLowercaseSetFor(set: Set<string>): Set<string> {
  const cached = lowercaseSetCache.get(set)
  if (cached && cachedSetSnapshotMatches(set, cached.sourceValues)) {
    return cached.values
  }

  const sourceValues = Array.from(set)
  const values = new Set(sourceValues.map((value) => value.toLowerCase()))
  lowercaseSetCache.set(set, { sourceValues, values })
  return values
}
