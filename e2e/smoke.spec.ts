import { expect, test, type Page } from '@playwright/test'
import { inputDebounceMs } from '../src/core/constants'
import { licenses } from '../src/data/licenses.generated'

const inputTooLargeError =
  'Input is too large; the limit is 1 MiB. Use a smaller file or paste less text.'
const pasteTooLargeError =
  'Pasted text would make the input too large; the existing input was not changed.'
const pastePlainTextUnavailableError =
  'Pasted content must include plain text; the existing input was not changed.'
const droppedFileEmptyError = 'Dropped file is empty.'
const droppedFileTooLargeResult = 'Dropped file is too large to analyze.'
const unableToAnalyzeInputResult = 'Unable to analyze the current input.'
const unableToReadDroppedFileError = 'Unable to read the dropped file.'
const overOneMiBByteLength = 1024 * 1024 + 1
const normalizationExpandedText = 'ﷺ'.repeat(32_000)

const byId = new Map(
  licenses.map((license) => [license.licenseId, license.text]),
)

function requireLicenseText(id: string): string {
  const text = byId.get(id)
  if (!text) throw new Error('Missing license fixture: ' + id)
  return text
}

async function checkText(
  page: Page,
  text: string,
  expected: string,
): Promise<void> {
  await page.getByLabel('License text').fill(text)
  await expect(
    page.locator('#results').getByText(expected).first(),
  ).toBeVisible()
}

function errorBanner(page: Page) {
  return page.getByRole('alert')
}

async function dispatchNativePaste(page: Page, text: string): Promise<boolean> {
  return page.getByLabel('License text').evaluate((node, pastedText) => {
    const data = new DataTransfer()
    data.setData('text/plain', pastedText)
    const defaultPrevented = !node.dispatchEvent(
      new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: data,
      }),
    )

    if (!defaultPrevented) {
      const textarea = node as HTMLTextAreaElement
      const start = textarea.selectionStart
      const end = textarea.selectionEnd
      textarea.setRangeText(pastedText, start, end, 'end')
      textarea.dispatchEvent(
        new InputEvent('input', {
          bubbles: true,
          data: pastedText,
          inputType: 'insertFromPaste',
        }),
      )
    }

    return defaultPrevented
  }, text)
}

async function dispatchNativePasteWithoutPlainText(
  page: Page,
): Promise<boolean> {
  return page.getByLabel('License text').evaluate((node, byteLength) => {
    const data = new DataTransfer()
    data.setData('text/html', '<p>' + 'x'.repeat(byteLength) + '</p>')
    return !node.dispatchEvent(
      new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: data,
      }),
    )
  }, overOneMiBByteLength)
}

async function dispatchNativePasteWithoutClipboardData(
  page: Page,
): Promise<boolean> {
  return page.getByLabel('License text').evaluate((node) => {
    return !node.dispatchEvent(
      new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
      }),
    )
  })
}

async function dropFile(
  page: Page,
  fileBits: string | number[],
  type = 'text/plain',
): Promise<void> {
  await page.getByTestId('drop-zone').dispatchEvent('drop', {
    dataTransfer: await page.evaluateHandle(
      ({ bits, fileType }) => {
        const data = new DataTransfer()
        const filePart = typeof bits === 'string' ? bits : new Uint8Array(bits)
        data.items.add(new File([filePart], 'LICENSE', { type: fileType }))
        return data
      },
      { bits: fileBits, fileType: type },
    ),
  })
}

function utf16Bytes(text: string, endian: 'le' | 'be', withBom: boolean) {
  const bytes = new Uint8Array((withBom ? 2 : 0) + text.length * 2)
  let offset = 0
  if (withBom) {
    bytes[0] = endian === 'le' ? 0xff : 0xfe
    bytes[1] = endian === 'le' ? 0xfe : 0xff
    offset = 2
  }
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    bytes[offset + index * 2] = endian === 'le' ? code & 0xff : code >> 8
    bytes[offset + index * 2 + 1] = endian === 'le' ? code >> 8 : code & 0xff
  }
  return Array.from(bytes)
}

test('identifies common license text and unknown input', async ({ page }) => {
  await page.goto('./')
  await checkText(page, requireLicenseText('MIT'), 'MIT')
  await checkText(page, requireLicenseText('Apache-2.0'), 'Apache-2.0')
  await checkText(page, requireLicenseText('GPL-3.0-only'), 'GPL-3.0-only')
  await checkText(page, 'SPDX-License-Identifier: MIT', 'Exact')
  await expect(page.locator('#results').getByText('Diff summary')).toHaveCount(
    0,
  )
  await checkText(page, 'Licensed under MIT', 'Likely')
  await expect(page.locator('#results').getByText('Diff summary')).toHaveCount(
    0,
  )
  await checkText(
    page,
    'Release notes, screenshots, install tips, and unrelated README text.',
    'Unknown',
  )
})

test('shows unsupported SPDX expressions without exact matches', async ({
  page,
}) => {
  await page.goto('./')
  for (const expression of [
    'MIT OR Apache-2.0',
    'Apache-2.0 WITH LLVM-exception',
  ]) {
    await page
      .getByLabel('License text')
      .fill('SPDX-License-Identifier: ' + expression)
    await expect(page.locator('#results')).toContainText('future parser')
    await expect(page.locator('#results')).toContainText(
      'SPDX expression: ' + expression,
    )
    await expect(page.locator('#results').getByText('Exact')).toHaveCount(0)
  }
})

test('loads dropped LICENSE file text', async ({ page }) => {
  await page.goto('./')
  const text = requireLicenseText('MIT')
  await dropFile(page, text)
  await expect(page.locator('#results').getByText('MIT').first()).toBeVisible()
})

test('loads dropped UTF-16 LICENSE file text', async ({ page }) => {
  await page.goto('./')
  const text = requireLicenseText('MIT')

  for (const [endian, withBom] of [
    ['le', true],
    ['be', true],
    ['le', false],
    ['be', false],
  ] as const) {
    await page.getByLabel('License text').fill('')
    await expect(page.getByLabel('License text')).toHaveValue('')
    await dropFile(page, utf16Bytes(text, endian, withBom))
    await expect(page.getByLabel('License text')).toHaveValue(text)
    await expect(
      page.locator('#results').getByText('MIT').first(),
    ).toBeVisible()
  }
})

test('rejects dropped binary-looking files', async ({ page }) => {
  await page.goto('./')
  await checkText(page, requireLicenseText('MIT'), 'MIT')

  await dropFile(page, [0, 1, 2, 3, 4, 5, 6, 7], 'application/octet-stream')

  await expect(
    page.getByText(
      'Dropped file does not look like text. Paste license text or drop a text file.',
    ),
  ).toBeVisible()
  await expect(page.locator('#results').getByText('MIT').first()).toBeVisible()
  await expect(page.locator('#results')).not.toContainText(
    'Unable to analyze dropped file.',
  )
})

test('rejects empty dropped files without clearing current input', async ({
  page,
}) => {
  await page.goto('./')
  const mitText = requireLicenseText('MIT')
  await checkText(page, mitText, 'MIT')

  await dropFile(page, '')

  await expect(page.getByText(droppedFileEmptyError)).toBeVisible()
  await expect(page.getByLabel('License text')).toHaveValue(mitText)
  await expect(page.locator('#results').getByText('MIT').first()).toBeVisible()
  await expect(page.locator('#results')).not.toContainText(
    'Unable to analyze dropped file.',
  )
})

test('clears stale invalid state when dropped-file errors follow valid input', async ({
  page,
}) => {
  await page.clock.install()
  await page.goto('./')
  await page.getByLabel('License text').evaluate((node) => {
    const textarea = node as HTMLTextAreaElement
    textarea.value = 'a'.repeat(1_100_000)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await expect(errorBanner(page)).toHaveText(inputTooLargeError)
  await expect(page.getByLabel('License text')).toHaveAttribute(
    'aria-invalid',
    'true',
  )

  await page.getByLabel('License text').evaluate((node) => {
    const textarea = node as HTMLTextAreaElement
    textarea.value = 'SPDX-License-Identifier: MIT'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await dropFile(page, '')

  await expect(errorBanner(page)).toHaveText(droppedFileEmptyError)
  await expect(page.getByLabel('License text')).not.toHaveAttribute(
    'aria-invalid',
  )
  await page.clock.fastForward(inputDebounceMs + 100)
  await expect(errorBanner(page)).toHaveText(droppedFileEmptyError)
  await expect(page.getByLabel('License text')).not.toHaveAttribute(
    'aria-invalid',
  )
})

test('prevents file drops outside the drop zone from navigating away', async ({
  page,
}) => {
  await page.goto('./')
  const defaultPrevented = await page.evaluate(() => {
    const data = new DataTransfer()
    data.items.add(new File(['text'], 'LICENSE', { type: 'text/plain' }))
    const event = new DragEvent('drop', {
      bubbles: true,
      cancelable: true,
      dataTransfer: data,
    })
    return !document.body.dispatchEvent(event)
  })

  expect(defaultPrevented).toBe(true)
  await expect(page.getByLabel('License text')).toBeVisible()
})

test('clears stale results after rejecting an oversized dropped file', async ({
  page,
}) => {
  await page.goto('./')
  await checkText(page, requireLicenseText('MIT'), 'MIT')

  await page.getByTestId('drop-zone').dispatchEvent('drop', {
    dataTransfer: await page.evaluateHandle((byteLength) => {
      const data = new DataTransfer()
      data.items.add(new File(['x'.repeat(byteLength)], 'LICENSE'))
      return data
    }, overOneMiBByteLength),
  })

  await expect(errorBanner(page)).toHaveText(droppedFileTooLargeResult)
  await expect(page.getByLabel('License text')).not.toHaveAttribute(
    'aria-invalid',
  )
  await expect(page.getByLabel('License text')).toHaveAttribute(
    'aria-describedby',
    'license-input-error',
  )
  await expect(page.locator('#results')).toHaveAttribute('aria-live', 'off')
  await expect(page.locator('#results')).toContainText(
    unableToAnalyzeInputResult,
  )
  await expect(page.locator('#results')).not.toContainText(
    droppedFileTooLargeResult,
  )
  await expect(page.locator('#results')).not.toContainText('MIT License')

  await checkText(page, requireLicenseText('ISC'), 'ISC')
  await expect(errorBanner(page)).toHaveCount(0)
  await expect(page.locator('#results')).toHaveAttribute('aria-live', 'polite')
})

test('loads dropped file text within the raw byte limit', async ({ page }) => {
  await page.goto('./')
  const mitText = requireLicenseText('MIT')
  await checkText(page, mitText, 'MIT')

  await dropFile(page, normalizationExpandedText)

  await expect(page.getByText(inputTooLargeError)).toHaveCount(0)
  await expect(page.getByLabel('License text')).toHaveValue(
    normalizationExpandedText,
  )
  await expect(page.locator('#results')).toContainText('Unknown')
  await expect(page.locator('#results')).not.toContainText(
    droppedFileTooLargeResult,
  )
})

test('keeps oversized drop results after a pending input debounce', async ({
  page,
}) => {
  await page.clock.install()
  await page.goto('./')
  await page.getByLabel('License text').fill('SPDX-License-Identifier: MIT')

  await page.getByTestId('drop-zone').dispatchEvent('drop', {
    dataTransfer: await page.evaluateHandle((byteLength) => {
      const data = new DataTransfer()
      data.items.add(new File(['x'.repeat(byteLength)], 'LICENSE'))
      return data
    }, overOneMiBByteLength),
  })

  await expect(errorBanner(page)).toHaveText(droppedFileTooLargeResult)
  await page.clock.fastForward(inputDebounceMs + 100)
  await expect(page.locator('#results')).toContainText(
    unableToAnalyzeInputResult,
  )
  await expect(page.locator('#results')).not.toContainText(
    droppedFileTooLargeResult,
  )
  await expect(page.locator('#results')).not.toContainText('MIT License')
})

test('keeps invalid state when oversized drop follows oversized input', async ({
  page,
}) => {
  await page.goto('./')
  await page.getByLabel('License text').evaluate((node) => {
    const textarea = node as HTMLTextAreaElement
    textarea.value = 'a'.repeat(1_100_000)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await expect(errorBanner(page)).toHaveText(inputTooLargeError)
  await expect(page.getByLabel('License text')).toHaveAttribute(
    'aria-invalid',
    'true',
  )

  await page.getByTestId('drop-zone').dispatchEvent('drop', {
    dataTransfer: await page.evaluateHandle((byteLength) => {
      const data = new DataTransfer()
      data.items.add(new File(['x'.repeat(byteLength)], 'LICENSE'))
      return data
    }, overOneMiBByteLength),
  })

  await expect(errorBanner(page)).toHaveText(droppedFileTooLargeResult)
  await expect(page.getByLabel('License text')).toHaveAttribute(
    'aria-invalid',
    'true',
  )
  await expect(page.locator('#results')).toContainText(
    unableToAnalyzeInputResult,
  )
  await expect(page.locator('#results')).not.toContainText(inputTooLargeError)
  await expect(page.locator('#results')).not.toContainText(
    droppedFileTooLargeResult,
  )
})

test('keeps current results after dropped-file read errors', async ({
  page,
}) => {
  await page.clock.install()
  await page.goto('./')
  await page.getByLabel('License text').fill('SPDX-License-Identifier: MIT')

  await page.getByTestId('drop-zone').dispatchEvent('drop', {
    dataTransfer: await page.evaluateHandle(() => {
      const file = new File(['MIT text'], 'LICENSE', { type: 'text/plain' })
      Object.defineProperty(file, 'arrayBuffer', {
        value: () => Promise.reject(new Error('Read failed')),
      })
      const data = new DataTransfer()
      data.items.add(file)
      return data
    }),
  })

  await expect(page.getByText(unableToReadDroppedFileError)).toBeVisible()
  await page.clock.fastForward(inputDebounceMs + 100)
  await expect(page.getByText(unableToReadDroppedFileError)).toBeVisible()
  await expect(page.locator('#results')).not.toContainText(
    'Unable to analyze dropped file.',
  )
  await expect(page.locator('#results').getByText('MIT License')).toBeVisible()
})

test('normal native paste invalidates pending dropped-file reads', async ({
  page,
}) => {
  await page.goto('./')
  const initialText = 'SPDX-License-Identifier: ISC'
  const droppedText = 'SPDX-License-Identifier: Apache-2.0'
  const pastedText = 'MIT'

  await page.getByLabel('License text').fill(initialText)
  await page.getByTestId('drop-zone').dispatchEvent('drop', {
    dataTransfer: await page.evaluateHandle((text) => {
      const file = new File([''], 'LICENSE', { type: 'text/plain' })
      Object.defineProperty(file, 'arrayBuffer', {
        value: () =>
          new Promise<ArrayBuffer>((resolve) => {
            const testWindow = window as Window & {
              resolveDroppedText?: () => void
            }
            testWindow.resolveDroppedText = () => {
              const bytes = new TextEncoder().encode(text)
              const buffer = new ArrayBuffer(bytes.byteLength)
              new Uint8Array(buffer).set(bytes)
              resolve(buffer)
            }
          }),
      })
      const data = new DataTransfer()
      data.items.add(file)
      return data
    }, droppedText),
  })

  await page.getByLabel('License text').evaluate((node) => {
    const textarea = node as HTMLTextAreaElement
    textarea.selectionStart = textarea.value.length
    textarea.selectionEnd = textarea.value.length
  })
  await dispatchNativePaste(page, pastedText)
  await expect(page.getByLabel('License text')).toHaveValue(
    initialText + pastedText,
  )
  await page.evaluate(() => {
    const testWindow = window as Window & { resolveDroppedText?: () => void }
    testWindow.resolveDroppedText?.()
  })

  await expect(page.getByLabel('License text')).toHaveValue(
    initialText + pastedText,
  )
})

test('unreadable native paste invalidates pending dropped-file reads', async ({
  page,
}) => {
  await page.goto('./')
  const initialText = 'SPDX-License-Identifier: ISC'
  const droppedText = 'SPDX-License-Identifier: Apache-2.0'

  await page.getByLabel('License text').fill(initialText)
  await expect(page.locator('#results').getByText('ISC').first()).toBeVisible()
  await page.getByTestId('drop-zone').dispatchEvent('drop', {
    dataTransfer: await page.evaluateHandle((text) => {
      const file = new File([''], 'LICENSE', { type: 'text/plain' })
      Object.defineProperty(file, 'arrayBuffer', {
        value: () =>
          new Promise<ArrayBuffer>((resolve) => {
            const testWindow = window as Window & {
              resolveDroppedText?: () => void
            }
            testWindow.resolveDroppedText = () => {
              const bytes = new TextEncoder().encode(text)
              const buffer = new ArrayBuffer(bytes.byteLength)
              new Uint8Array(buffer).set(bytes)
              resolve(buffer)
            }
          }),
      })
      const data = new DataTransfer()
      data.items.add(file)
      return data
    }, droppedText),
  })

  const defaultPrevented = await dispatchNativePasteWithoutPlainText(page)

  expect(defaultPrevented).toBe(true)
  await expect(errorBanner(page)).toHaveText(pastePlainTextUnavailableError)
  await expect(page.getByLabel('License text')).toHaveValue(initialText)
  await page.evaluate(() => {
    const testWindow = window as Window & { resolveDroppedText?: () => void }
    testWindow.resolveDroppedText?.()
  })

  await expect(page.getByLabel('License text')).toHaveValue(initialText)
  await expect(errorBanner(page)).toHaveText(pastePlainTextUnavailableError)
  await expect(page.locator('#results')).not.toContainText('Apache-2.0')
})

test('shows color-coded diff summaries for changed full texts', async ({
  page,
}) => {
  await page.goto('./')
  const gplText = requireLicenseText('GPL-3.0-only')
  const text = gplText.replace(
    'freedom to share and change',
    'freedom to share and inspect',
  )
  expect(text).not.toBe(gplText)

  await page.getByLabel('License text').fill(text)
  await expect(page.locator('summary').first()).toBeVisible()
  await page.locator('summary').first().click()
  await expect(page.locator('#results ins').first()).toBeVisible()
  await expect(page.locator('#results del').first()).toBeVisible()
})

test('rejects oversized native paste without clearing current results', async ({
  page,
}) => {
  await page.goto('./')
  const mitText = requireLicenseText('MIT')
  await page.getByLabel('License text').fill(mitText)
  await expect(page.locator('#results').getByText('MIT').first()).toBeVisible()
  // Keep the initial debounced match on real timers before controlling the pending input below.
  await page.clock.install()

  await page.getByLabel('License text').evaluate((node) => {
    node.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const defaultPrevented = await dispatchNativePaste(page, '界'.repeat(400_000))

  expect(defaultPrevented).toBe(true)
  await expect(page.getByText(pasteTooLargeError)).toBeVisible()
  await page.clock.fastForward(inputDebounceMs + 100)
  await expect(page.getByText(pasteTooLargeError)).toBeVisible()
  await expect(page.getByLabel('License text')).toHaveValue(mitText)
  await expect(page.locator('#results').getByText('MIT').first()).toBeVisible()
  await expect(page.locator('#results')).not.toContainText(
    'Input is too large to analyze.',
  )
})

test('rejects native paste without readable plain text', async ({ page }) => {
  await page.goto('./')
  const mitText = requireLicenseText('MIT')
  await page.getByLabel('License text').fill(mitText)
  await expect(page.locator('#results').getByText('MIT').first()).toBeVisible()

  const defaultPrevented = await dispatchNativePasteWithoutPlainText(page)

  expect(defaultPrevented).toBe(true)
  await expect(page.getByText(pastePlainTextUnavailableError)).toBeVisible()
  await expect(page.getByLabel('License text')).not.toHaveAttribute(
    'aria-invalid',
  )
  await expect(page.getByLabel('License text')).toHaveValue(mitText)
  await expect(page.locator('#results').getByText('MIT').first()).toBeVisible()
})

test('keeps invalid state when unreadable paste follows oversized input', async ({
  page,
}) => {
  await page.goto('./')
  await page.getByLabel('License text').evaluate((node) => {
    const textarea = node as HTMLTextAreaElement
    textarea.value = 'a'.repeat(1_100_000)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await expect(errorBanner(page)).toHaveText(inputTooLargeError)

  const defaultPrevented = await dispatchNativePasteWithoutPlainText(page)

  expect(defaultPrevented).toBe(true)
  await expect(errorBanner(page)).toHaveText(pastePlainTextUnavailableError)
  await expect(page.getByLabel('License text')).toHaveAttribute(
    'aria-invalid',
    'true',
  )
  await expect(page.locator('#results')).toContainText(
    unableToAnalyzeInputResult,
  )
  await expect(page.locator('#results')).not.toContainText(inputTooLargeError)
  await expect(page.locator('#results')).not.toContainText(
    pastePlainTextUnavailableError,
  )
})

test('ignores synthetic paste events without clipboard data', async ({
  page,
}) => {
  await page.goto('./')
  const mitText = requireLicenseText('MIT')
  await page.getByLabel('License text').fill(mitText)
  await expect(page.locator('#results').getByText('MIT').first()).toBeVisible()

  const defaultPrevented = await dispatchNativePasteWithoutClipboardData(page)

  expect(defaultPrevented).toBe(false)
  await expect(page.getByText(pastePlainTextUnavailableError)).toHaveCount(0)
  await expect(page.getByLabel('License text')).toHaveValue(mitText)
})

test('accepts native paste within the raw byte limit', async ({ page }) => {
  await page.goto('./')
  const mitText = requireLicenseText('MIT')
  await page.getByLabel('License text').fill(mitText)
  await expect(page.locator('#results').getByText('MIT').first()).toBeVisible()

  const defaultPrevented = await dispatchNativePaste(
    page,
    normalizationExpandedText,
  )

  expect(defaultPrevented).toBe(false)
  await expect(page.getByText(pasteTooLargeError)).toHaveCount(0)
  await expect(page.getByLabel('License text')).toHaveValue(
    mitText + normalizationExpandedText,
  )
  await expect(page.locator('#results').getByText('MIT').first()).toBeVisible()
})

test('updates pending input results after rejecting oversized native paste', async ({
  page,
}) => {
  await page.goto('./')
  await page.getByLabel('License text').fill(requireLicenseText('MIT'))
  await expect(page.locator('#results').getByText('MIT').first()).toBeVisible()

  await page.getByLabel('License text').evaluate((node) => {
    const textarea = node as HTMLTextAreaElement
    textarea.value =
      'Release notes, screenshots, install tips, and unrelated README text.'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const defaultPrevented = await dispatchNativePaste(page, '界'.repeat(400_000))

  expect(defaultPrevented).toBe(true)
  await expect(page.getByText(pasteTooLargeError)).toBeVisible()
  await expect(page.locator('#results')).toContainText('Unknown')
  await expect(page.locator('#results')).not.toContainText('MIT License')
})

test('rejects paste that would make the combined input too large', async ({
  page,
}) => {
  await page.goto('./')
  await page.getByLabel('License text').evaluate((node) => {
    const textarea = node as HTMLTextAreaElement
    textarea.value = 'a'.repeat(900_000)
    textarea.selectionStart = textarea.value.length
    textarea.selectionEnd = textarea.value.length
  })
  const defaultPrevented = await dispatchNativePaste(page, 'b'.repeat(200_000))

  expect(defaultPrevented).toBe(true)
  await expect(page.getByText(pasteTooLargeError)).toBeVisible()
  await expect(page.getByLabel('License text')).not.toHaveAttribute(
    'aria-invalid',
  )
  await expect(page.getByLabel('License text')).toHaveValue('a'.repeat(900_000))

  const acceptedPastePrevented = await dispatchNativePaste(page, 'c')

  expect(acceptedPastePrevented).toBe(false)
  await expect(errorBanner(page)).toHaveCount(0)
  await expect(page.getByLabel('License text')).toHaveValue(
    'a'.repeat(900_000) + 'c',
  )
})

test('shows paste-specific error when existing input is already too large', async ({
  page,
}) => {
  await page.clock.install()
  await page.goto('./')
  await page.getByLabel('License text').evaluate((node) => {
    const textarea = node as HTMLTextAreaElement
    textarea.value = 'a'.repeat(1_100_000)
    textarea.selectionStart = textarea.value.length
    textarea.selectionEnd = textarea.value.length

    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const defaultPrevented = await dispatchNativePaste(page, 'b')

  expect(defaultPrevented).toBe(true)
  await expect(errorBanner(page)).toHaveText(pasteTooLargeError)
  await expect(page.getByLabel('License text')).toHaveAttribute(
    'aria-invalid',
    'true',
  )
  await page.clock.fastForward(inputDebounceMs + 100)
  await expect(errorBanner(page)).toHaveText(pasteTooLargeError)
  await expect(errorBanner(page)).not.toHaveText(inputTooLargeError)
  await expect(page.locator('#results')).toContainText(
    unableToAnalyzeInputResult,
  )
  await expect(page.locator('#results')).not.toContainText(pasteTooLargeError)
  await expect(page.locator('#results')).not.toContainText(inputTooLargeError)
  await expect(page.getByLabel('License text')).toHaveValue(
    'a'.repeat(1_100_000),
  )
})

test('rejects oversized textarea input by byte size before matching', async ({
  page,
}) => {
  await page.goto('./')
  await page.getByLabel('License text').evaluate((node) => {
    const textarea = node as HTMLTextAreaElement
    textarea.value = '界'.repeat(400_000)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })

  await expect(errorBanner(page)).toHaveText(inputTooLargeError)
  await expect(page.getByLabel('License text')).toHaveAttribute(
    'aria-invalid',
    'true',
  )
  await expect(page.locator('#results')).toContainText(
    unableToAnalyzeInputResult,
  )
  await expect(page.locator('#results')).not.toContainText(inputTooLargeError)
})

test('accepts textarea input within the raw byte limit', async ({ page }) => {
  await page.goto('./')
  await page.getByLabel('License text').evaluate((node) => {
    const textarea = node as HTMLTextAreaElement
    textarea.value = 'ﷺ'.repeat(32_000)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })

  await expect(page.getByText(inputTooLargeError)).toHaveCount(0)
  await expect(page.getByLabel('License text')).toHaveValue(
    normalizationExpandedText,
  )
  await expect(page.locator('#results')).toContainText('Unknown')
  await expect(page.locator('#results')).not.toContainText(
    'Input is too large to analyze.',
  )
})
