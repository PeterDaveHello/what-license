import { describe, expect, it, vi } from 'vitest'
import { renderResponse } from '../src/ui/render'
import {
  bindFileDrop,
  droppedFileEmptyMessage,
  inputNotTextMessage,
  multipleFilesDroppedMessage,
  unableToReadDroppedFileMessage,
} from '../src/ui/file-drop'

function textFile(text: string): File {
  return new File([text], 'LICENSE', { type: 'text/plain' })
}

function arrayBufferFromBytes(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buffer).set(bytes)
  return buffer
}

function bytesFile(bytes: Uint8Array): File {
  return new File([arrayBufferFromBytes(bytes)], 'LICENSE')
}

function delayedTextFile(text: Promise<string>): {
  size: number
  arrayBuffer: () => Promise<ArrayBuffer>
} {
  return {
    size: 1,
    arrayBuffer: async () =>
      arrayBufferFromBytes(new TextEncoder().encode(await text)),
  }
}

describe('response rendering', () => {
  it('renders unsupported SPDX-like input without injecting expression HTML', () => {
    const root = document.createElement('div')
    renderResponse(root, {
      inputType: 'spdx-expression',
      spdxExpression: 'MIT <script>alert(1)</script>',
      legacyAlias: {
        legacyId: 'GPL-2.0',
        candidates: ['GPL-2.0-only', 'GPL-2.0-or-later'],
        message: 'GPL-2.0 is a legacy SPDX ID.',
      },
      results: [],
      message: 'Unknown: unsupported SPDX expression.',
    })
    expect(root.querySelector('script')).toBeNull()
    expect(root.textContent).toContain('MIT <script>alert(1)</script>')
    expect(root.textContent).toContain('GPL-2.0 is a legacy SPDX ID.')
  })

  it('renders result details and diffs without injecting HTML', () => {
    const root = document.createElement('div')
    renderResponse(root, {
      inputType: 'license-notice',
      results: [
        {
          licenseId: 'MIT" data-x="<script>alert(1)</script>',
          name: 'MIT <img src=x onerror=alert(1)>',
          confidence: 'Likely',
          inputType: 'license-notice',
          score: { f1: 0.9, precision: 0.9, recall: 0.9 },
          flags: {
            isDeprecated: false,
            isOsiApproved: false,
            isFsfLibre: true,
            needsManualReview: false,
            isLegacyId: false,
          },
          explanation: '<script>alert(2)</script>',
          seeAlso: [],
          diff: '<img src=x onerror=alert(3)>',
        },
      ],
      message: 'Ranked <script>alert(4)</script>',
    })

    expect(root.querySelector('script')).toBeNull()
    expect(root.querySelector('img')).toBeNull()
    expect(root.querySelector('[onerror]')).toBeNull()
    expect(root.textContent).toContain('license-notice')
    expect(root.textContent).toContain('FSF libre')
    expect(root.textContent).toContain('<img src=x onerror=alert(3)>')
  })

  it('renders diff segments with semantic insertions and deletions', () => {
    const root = document.createElement('div')
    renderResponse(root, {
      inputType: 'full-license-text',
      results: [
        {
          licenseId: 'MIT',
          name: 'MIT License',
          confidence: 'Likely',
          inputType: 'full-license-text',
          score: { f1: 0.99, precision: 0.99, recall: 0.99 },
          flags: {
            isDeprecated: false,
            isOsiApproved: true,
            needsManualReview: false,
            isLegacyId: false,
          },
          explanation: 'Most distinctive license shingles match this license.',
          seeAlso: [],
          diff: '+ employer - organization',
          diffSegments: [
            { type: 'equal', text: 'You should also get your' },
            { type: 'insert', text: 'employer' },
            { type: 'delete', text: 'organization' },
          ],
        },
      ],
      message: 'License candidates ranked by shingle F1 score.',
    })

    expect(root.querySelector('ins')?.textContent).toBe('+ employer')
    expect(root.querySelector('del')?.textContent).toBe('- organization')
    expect(root.querySelector('ins')?.className).toContain('emerald')
    expect(root.querySelector('del')?.className).toContain('red')
    expect(root.textContent).toContain(
      'Green text is in the matched license; red text is extra in the input.',
    )
  })

  it('hides the color legend when there are no visible differences', () => {
    const root = document.createElement('div')
    renderResponse(root, {
      inputType: 'full-license-text',
      results: [
        {
          licenseId: 'MIT',
          name: 'MIT License',
          confidence: 'Exact',
          inputType: 'full-license-text',
          score: { f1: 1, precision: 1, recall: 1 },
          flags: {
            isDeprecated: false,
            isOsiApproved: true,
            needsManualReview: false,
            isLegacyId: false,
          },
          explanation: 'The normalized text is an almost exact match.',
          seeAlso: [],
          diff: 'No material differences after normalization.',
          diffSegments: [
            {
              type: 'equal',
              text: 'No material differences after normalization.',
            },
          ],
        },
      ],
      message: 'License candidates ranked by shingle F1 score.',
    })

    const legend = Array.from(root.querySelectorAll('p')).find(
      (node) =>
        node.textContent ===
        'Green text is in the matched license; red text is extra in the input.',
    )
    expect(legend?.hidden).toBe(true)
  })

  it('loads lazy diffs only when details expand', () => {
    const root = document.createElement('div')
    const loadDiff = vi.fn(() => '<script>alert(5)</script>')
    const loadDiffSegments = vi.fn(() => [
      { type: 'insert' as const, text: '<script>alert(5)</script>' },
      { type: 'delete' as const, text: 'removed text' },
    ])
    renderResponse(
      root,
      {
        inputType: 'full-license-text',
        results: [
          {
            licenseId: 'MIT',
            name: 'MIT License',
            confidence: 'Likely',
            inputType: 'full-license-text',
            score: { f1: 0.99, precision: 0.99, recall: 0.99 },
            flags: {
              isDeprecated: false,
              isOsiApproved: true,
              needsManualReview: false,
              isLegacyId: false,
            },
            explanation:
              'Most distinctive license shingles match this license.',
            seeAlso: [],
          },
        ],
        message: 'License candidates ranked by shingle F1 score.',
      },
      { loadDiff, loadDiffSegments },
    )

    expect(loadDiff).not.toHaveBeenCalled()
    expect(loadDiffSegments).not.toHaveBeenCalled()
    const details = root.querySelector('details')
    expect(details).not.toBeNull()
    details!.open = true
    details!.dispatchEvent(new Event('toggle'))
    details!.dispatchEvent(new Event('toggle'))

    expect(loadDiff).not.toHaveBeenCalled()
    expect(loadDiffSegments).toHaveBeenCalledTimes(1)
    expect(root.querySelector('script')).toBeNull()
    expect(root.querySelector('ins')?.textContent).toBe(
      '+ <script>alert(5)</script>',
    )
    expect(root.querySelector('del')?.textContent).toBe('- removed text')
  })

  it('uses lazy diff text when lazy diff segments are empty', () => {
    const root = document.createElement('div')
    const loadDiff = vi.fn(() => '<script>alert(5)</script>')
    const loadDiffSegments = vi.fn(() => [])
    renderResponse(
      root,
      {
        inputType: 'full-license-text',
        results: [
          {
            licenseId: 'MIT',
            name: 'MIT License',
            confidence: 'Likely',
            inputType: 'full-license-text',
            score: { f1: 0.99, precision: 0.99, recall: 0.99 },
            flags: {
              isDeprecated: false,
              isOsiApproved: true,
              needsManualReview: false,
              isLegacyId: false,
            },
            explanation:
              'Most distinctive license shingles match this license.',
            seeAlso: [],
          },
        ],
        message: 'License candidates ranked by shingle F1 score.',
      },
      { loadDiff, loadDiffSegments },
    )

    const details = root.querySelector('details')
    expect(details).not.toBeNull()
    details!.open = true
    details!.dispatchEvent(new Event('toggle'))

    expect(loadDiffSegments).toHaveBeenCalledTimes(1)
    expect(loadDiff).toHaveBeenCalledTimes(1)
    expect(root.querySelector('script')).toBeNull()
    expect(root.textContent).toContain('<script>alert(5)</script>')
  })

  it('does not render lazy diff details when eager diff segments are empty', () => {
    const root = document.createElement('div')
    const loadDiff = vi.fn(() => 'fallback diff')
    renderResponse(
      root,
      {
        inputType: 'full-license-text',
        results: [
          {
            licenseId: 'MIT',
            name: 'MIT License',
            confidence: 'Likely',
            inputType: 'full-license-text',
            score: { f1: 0.99, precision: 0.99, recall: 0.99 },
            flags: {
              isDeprecated: false,
              isOsiApproved: true,
              needsManualReview: false,
              isLegacyId: false,
            },
            explanation:
              'Most distinctive license shingles match this license.',
            diffSegments: [],
            seeAlso: [],
          },
        ],
        message: 'License candidates ranked by shingle F1 score.',
      },
      { loadDiff },
    )

    expect(root.querySelector('details')).toBeNull()
    expect(loadDiff).not.toHaveBeenCalled()
    expect(root.textContent).not.toContain('fallback diff')
  })

  it('does not render diff details for empty eager diff segments without lazy loaders', () => {
    const root = document.createElement('div')
    renderResponse(root, {
      inputType: 'full-license-text',
      results: [
        {
          licenseId: 'MIT',
          name: 'MIT License',
          confidence: 'Likely',
          inputType: 'full-license-text',
          score: { f1: 0.99, precision: 0.99, recall: 0.99 },
          flags: {
            isDeprecated: false,
            isOsiApproved: true,
            needsManualReview: false,
            isLegacyId: false,
          },
          explanation: 'Most distinctive license shingles match this license.',
          diffSegments: [],
          seeAlso: [],
        },
      ],
      message: 'License candidates ranked by shingle F1 score.',
    })

    expect(root.querySelector('details')).toBeNull()
  })

  it('does not retry lazy diff loading after a failure', () => {
    const root = document.createElement('div')
    const loadDiff = vi.fn(() => {
      throw new Error('Diff failed')
    })

    renderResponse(
      root,
      {
        inputType: 'full-license-text',
        results: [
          {
            licenseId: 'MIT',
            name: 'MIT License',
            confidence: 'Likely',
            inputType: 'full-license-text',
            score: { f1: 0.99, precision: 0.99, recall: 0.99 },
            flags: {
              isDeprecated: false,
              isOsiApproved: true,
              needsManualReview: false,
              isLegacyId: false,
            },
            explanation:
              'Most distinctive license shingles match this license.',
            seeAlso: [],
          },
        ],
        message: 'License candidates ranked by shingle F1 score.',
      },
      { loadDiff },
    )

    const details = root.querySelector('details')
    expect(details).not.toBeNull()
    details!.open = true
    details!.dispatchEvent(new Event('toggle'))
    details!.open = false
    details!.dispatchEvent(new Event('toggle'))
    details!.open = true
    details!.dispatchEvent(new Event('toggle'))

    expect(loadDiff).toHaveBeenCalledTimes(1)
    expect(root.textContent).toContain('Unable to load diff summary.')
  })
})

describe('file drop handling', () => {
  it('invalidates pending input before rejecting oversized drops', () => {
    const target = document.createElement('div')
    const calls: string[] = []
    const cleanup = bindFileDrop(
      target,
      () => calls.push('text'),
      () => calls.push('error'),
      () => calls.push('start'),
    )

    const event = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'dataTransfer', {
      value: {
        types: ['Files'],
        files: [{ size: 1024 * 1024 + 1 }],
      },
    })

    target.dispatchEvent(event)

    expect(calls).toEqual(['start', 'error'])

    cleanup()
    const ignoredEvent = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(ignoredEvent, 'dataTransfer', {
      value: {
        types: ['Files'],
        files: [{ size: 1024 * 1024 + 1 }],
      },
    })

    target.dispatchEvent(ignoredEvent)

    expect(calls).toEqual(['start', 'error'])
  })

  it('does not invalidate pending input when a Files drop has no file', () => {
    const target = document.createElement('div')
    const calls: string[] = []
    const cleanup = bindFileDrop(
      target,
      () => calls.push('text'),
      () => calls.push('error'),
      () => calls.push('start'),
    )

    const drop = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(drop, 'dataTransfer', {
      value: {
        types: ['Files'],
        files: [],
      },
    })

    expect(target.dispatchEvent(drop)).toBe(false)
    expect(calls).toEqual([])

    cleanup()
  })

  it('handles drops with files even when the Files type is missing', async () => {
    const target = document.createElement('div')
    const calls: string[] = []
    const cleanup = bindFileDrop(
      target,
      (text) => calls.push('text:' + text),
      () => calls.push('error'),
      () => calls.push('start'),
    )

    const drop = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(drop, 'dataTransfer', {
      value: {
        types: [],
        files: [textFile('MIT text')],
      },
    })

    expect(target.dispatchEvent(drop)).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(calls).toEqual(['start', 'text:MIT text'])

    cleanup()
  })

  it('rejects drops with multiple files', () => {
    const target = document.createElement('div')
    const calls: string[] = []
    const cleanup = bindFileDrop(
      target,
      (text) => calls.push('text:' + text),
      (message) => calls.push('error:' + message),
      () => calls.push('start'),
    )

    const drop = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(drop, 'dataTransfer', {
      value: {
        types: ['Files'],
        files: [textFile('MIT'), textFile('Apache')],
      },
    })

    expect(target.dispatchEvent(drop)).toBe(false)
    expect(calls).toEqual(['start', 'error:' + multipleFilesDroppedMessage])

    cleanup()
  })

  it('uses a stable message for dropped-file read errors', async () => {
    const target = document.createElement('div')
    const calls: string[] = []
    const cleanup = bindFileDrop(
      target,
      (text) => calls.push('text:' + text),
      (message) => calls.push('error:' + message),
      () => calls.push('start'),
    )

    const drop = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(drop, 'dataTransfer', {
      value: {
        types: ['Files'],
        files: [
          {
            size: 1,
            arrayBuffer: () => Promise.reject(new Error('Read failed')),
          },
        ],
      },
    })

    expect(target.dispatchEvent(drop)).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(calls).toEqual(['start', 'error:' + unableToReadDroppedFileMessage])

    cleanup()
  })

  it('rejects empty dropped text files', async () => {
    const target = document.createElement('div')
    const calls: string[] = []
    const cleanup = bindFileDrop(
      target,
      (text) => calls.push('text:' + text),
      (message) => calls.push('error:' + message),
      () => calls.push('start'),
    )

    const drop = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(drop, 'dataTransfer', {
      value: {
        types: ['Files'],
        files: [textFile('')],
      },
    })

    expect(target.dispatchEvent(drop)).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(calls).toEqual(['start', 'error:' + droppedFileEmptyMessage])

    cleanup()
  })

  it('accepts common whitespace controls in dropped text files', async () => {
    const target = document.createElement('div')
    const calls: string[] = []
    const cleanup = bindFileDrop(
      target,
      (text) => calls.push('text:' + text),
      (message) => calls.push('error:' + message),
      () => calls.push('start'),
    )

    const text = 'MIT\fLicense\vText'
    const drop = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(drop, 'dataTransfer', {
      value: {
        types: ['Files'],
        files: [textFile(text)],
      },
    })

    expect(target.dispatchEvent(drop)).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(calls).toEqual(['start', 'text:' + text])

    cleanup()
  })

  it('rejects dropped files that do not look like text', async () => {
    const target = document.createElement('div')
    const calls: string[] = []
    const cleanup = bindFileDrop(
      target,
      (text) => calls.push('text:' + text),
      (message) => calls.push('error:' + message),
      () => calls.push('start'),
    )

    const drop = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(drop, 'dataTransfer', {
      value: {
        types: ['Files'],
        files: [bytesFile(new Uint8Array([0, 1, 2, 3]))],
      },
    })

    expect(target.dispatchEvent(drop)).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(calls).toEqual(['start', 'error:' + inputNotTextMessage])

    cleanup()
  })

  it('rejects decoded UTF-16 control-character drops', async () => {
    const target = document.createElement('div')
    const calls: string[] = []
    const cleanup = bindFileDrop(
      target,
      (text) => calls.push('text:' + text),
      (message) => calls.push('error:' + message),
      () => calls.push('start'),
    )

    const drop = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(drop, 'dataTransfer', {
      value: {
        types: ['Files'],
        files: [bytesFile(new Uint8Array([1, 0, 2, 0, 3, 0, 4, 0]))],
      },
    })

    expect(target.dispatchEvent(drop)).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(calls).toEqual(['start', 'error:' + inputNotTextMessage])

    cleanup()
  })

  it('allows text drops with rare replacement characters', async () => {
    const target = document.createElement('div')
    const calls: string[] = []
    const cleanup = bindFileDrop(
      target,
      (text) => calls.push('text:' + text),
      (message) => calls.push('error:' + message),
      () => calls.push('start'),
    )

    const text =
      'Copyright 2026 Example ' + 'a'.repeat(200) + String.fromCharCode(65533)
    const drop = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(drop, 'dataTransfer', {
      value: {
        types: ['Files'],
        files: [textFile(text)],
      },
    })

    expect(target.dispatchEvent(drop)).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(calls).toEqual(['start', 'text:' + text])

    cleanup()
  })

  it('rejects replacement-character-heavy drops by character count', async () => {
    const target = document.createElement('div')
    const calls: string[] = []
    const cleanup = bindFileDrop(
      target,
      (text) => calls.push('text:' + text),
      (message) => calls.push('error:' + message),
      () => calls.push('start'),
    )

    const text =
      String.fromCodePoint(0x1f600).repeat(100) +
      String.fromCharCode(65533) +
      String.fromCharCode(65533)
    const drop = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(drop, 'dataTransfer', {
      value: {
        types: ['Files'],
        files: [textFile(text)],
      },
    })

    expect(target.dispatchEvent(drop)).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(calls).toEqual(['start', 'error:' + inputNotTextMessage])

    cleanup()
  })

  it('decodes BOM and inferred Unicode text drops before binary heuristics', async () => {
    const cases = [
      {
        label: 'UTF-16LE BOM',
        bytes: [
          0xff, 0xfe, 0x4d, 0, 0x49, 0, 0x54, 0, 0x20, 0, 0x74, 0, 0x65, 0,
          0x78, 0, 0x74, 0,
        ],
        expected: 'MIT text',
      },
      {
        label: 'UTF-16BE BOM',
        bytes: [
          0xfe, 0xff, 0, 0x4d, 0, 0x49, 0, 0x54, 0, 0x20, 0, 0x74, 0, 0x65, 0,
          0x78, 0, 0x74,
        ],
        expected: 'MIT text',
      },
      {
        label: 'BOM-less UTF-16LE',
        bytes: [0xff, 0, 0x4d, 0, 0x49, 0, 0x54, 0],
        expected: String.fromCharCode(0xff) + 'MIT',
      },
      {
        label: 'BOM-less UTF-16BE',
        bytes: [0, 0x4d, 0, 0x49, 0, 0x54],
        expected: 'MIT',
      },
      {
        label: 'UTF-8 BOM',
        bytes: [
          0xef, 0xbb, 0xbf, 0x4d, 0x49, 0x54, 0x20, 0x74, 0x65, 0x78, 0x74,
        ],
        expected: 'MIT text',
      },
    ]

    for (const testCase of cases) {
      const target = document.createElement('div')
      const calls: string[] = []
      const cleanup = bindFileDrop(
        target,
        (text) => calls.push('text:' + text),
        (message) => calls.push('error:' + message),
        () => calls.push('start'),
      )

      const drop = new Event('drop', { bubbles: true, cancelable: true })
      Object.defineProperty(drop, 'dataTransfer', {
        value: {
          types: ['Files'],
          files: [bytesFile(new Uint8Array(testCase.bytes))],
        },
      })

      expect(target.dispatchEvent(drop), testCase.label).toBe(false)
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(calls, testCase.label).toEqual([
        'start',
        'text:' + testCase.expected,
      ])

      cleanup()
    }
  })

  it('ignores stale dropped-file reads', async () => {
    const target = document.createElement('div')
    const calls: string[] = []
    let activeRequestId = 0
    let resolveFirst: (text: string) => void = () => {}
    const firstText = new Promise<string>((resolve) => {
      resolveFirst = resolve
    })
    const cleanup = bindFileDrop(
      target,
      (text) => calls.push('text:' + text),
      (message) => calls.push('error:' + message),
      () => {
        activeRequestId += 1
        return activeRequestId
      },
      (requestId) => requestId === activeRequestId,
    )

    const firstDrop = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(firstDrop, 'dataTransfer', {
      value: {
        types: ['Files'],
        files: [delayedTextFile(firstText)],
      },
    })
    const secondDrop = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(secondDrop, 'dataTransfer', {
      value: {
        types: ['Files'],
        files: [textFile('new text')],
      },
    })

    target.dispatchEvent(firstDrop)
    target.dispatchEvent(secondDrop)
    await new Promise((resolve) => setTimeout(resolve, 0))
    resolveFirst('old text')
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(calls).toEqual(['text:new text'])

    cleanup()
  })

  it('allows non-file drags to use native browser behavior', () => {
    const target = document.createElement('div')
    const calls: string[] = []
    const cleanup = bindFileDrop(
      target,
      () => calls.push('text'),
      () => calls.push('error'),
      () => calls.push('start'),
    )

    const dragover = new Event('dragover', { bubbles: true, cancelable: true })
    Object.defineProperty(dragover, 'dataTransfer', {
      value: {
        types: ['text/plain'],
        files: [],
      },
    })
    const drop = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(drop, 'dataTransfer', {
      value: {
        types: ['text/plain'],
        files: [],
      },
    })

    expect(target.dispatchEvent(dragover)).toBe(true)
    expect(target.classList.contains('border-blue-500')).toBe(false)
    expect(target.dispatchEvent(drop)).toBe(true)
    expect(calls).toEqual([])

    cleanup()
  })
})
