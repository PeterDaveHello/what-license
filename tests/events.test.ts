import { afterEach, describe, expect, it, vi } from 'vitest'
import { debounce } from '../src/ui/events'

describe('debounce', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('reports rejected async callbacks', async () => {
    vi.useFakeTimers()
    const reportError = vi.fn()
    vi.stubGlobal('reportError', reportError)
    const error = new Error('match failed')
    const debounced = debounce(async () => {
      throw error
    }, 10)

    debounced()
    await vi.advanceTimersByTimeAsync(10)

    expect(reportError).toHaveBeenCalledWith(error)
  })
})
