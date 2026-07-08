type Debounced<Args extends unknown[]> = ((...args: Args) => void) & {
  cancel: () => void
}

export function debounce<Args extends unknown[]>(
  callback: (...args: Args) => void | Promise<void>,
  delayMs: number,
): Debounced<Args> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const debounced = ((...args: Args) => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      void Promise.resolve()
        .then(() => callback(...args))
        .catch(reportAsyncError)
    }, delayMs)
  }) as Debounced<Args>
  debounced.cancel = () => {
    clearTimeout(timer)
    timer = undefined
  }
  return debounced
}

function reportAsyncError(error: unknown): void {
  if (typeof globalThis.reportError === 'function') {
    globalThis.reportError(error)
    return
  }

  setTimeout(() => {
    throw error
  }, 0)
}

export function requireElement<T extends Element>(
  selector: string,
  root: ParentNode = document,
): T {
  const element = root.querySelector<T>(selector)
  if (!element) throw new Error('Missing element: ' + selector)
  return element
}
