export function retainEffectResourceThroughReplay<T>(
  activeResources: Set<T>,
  resource: T,
  dispose: () => void,
): () => void {
  activeResources.add(resource)
  return () => {
    activeResources.delete(resource)
    queueMicrotask(() => {
      if (activeResources.has(resource)) return
      dispose()
    })
  }
}
