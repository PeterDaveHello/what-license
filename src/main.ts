import './styles.css'
import { inputDebounceMs, maxDiffResults } from './core/constants'
import { diffForResult, diffSegmentsForResult, rankLicenses } from './core/rank'
import { resetInputShingleCache } from './core/score'
import type { LicenseEntry, MatchResponse } from './core/types'
import { writeClipboardText } from './ui/clipboard'
import { debounce, requireElement } from './ui/events'
import {
  bindFileDrop,
  inputTooLargeMessage,
  maxInputSize,
} from './ui/file-drop'
import { renderResponse } from './ui/render'

const pasteTooLargeMessage =
  'Pasted text would make the input too large; the existing input was not changed.'
const pastePlainTextUnavailableMessage =
  'Pasted content must include plain text; the existing input was not changed.'
const droppedFileTooLargeResultMessage = 'Dropped file is too large to analyze.'
const unableToAnalyzeInputMessage = 'Unable to analyze the current input.'
const unableToLoadLicenseDataMessage = 'Unable to load license data.'

let licenseDataPromise: Promise<LicenseEntry[]> | undefined

function loadLicenses(): Promise<LicenseEntry[]> {
  licenseDataPromise ??= import('./data/licenses.generated')
    .then(({ licenses }) => licenses)
    .catch((error: unknown) => {
      licenseDataPromise = undefined
      throw error
    })
  return licenseDataPromise
}

function emptyInputResponse(): MatchResponse {
  resetInputShingleCache()
  return {
    inputType: 'unknown',
    results: [],
    message: 'Paste license text to identify it.',
  }
}

function licenseText(licenses: LicenseEntry[], licenseId: string): string {
  return licenses.find((license) => license.licenseId === licenseId)?.text || ''
}

const sampleInputs = [
  {
    label: 'MIT full text',
    getText: async () => licenseText(await loadLicenses(), 'MIT'),
  },
  {
    label: 'MIT notice',
    getText: () =>
      'Copyright (c) 2026 Example\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction.\n\nThe above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.',
  },
  {
    label: 'Apache-2.0 full text',
    getText: async () => licenseText(await loadLicenses(), 'Apache-2.0'),
  },
  {
    label: 'Apache header',
    getText: () =>
      'Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License.',
  },
  {
    label: 'GPL-3.0-only',
    getText: async () => licenseText(await loadLicenses(), 'GPL-3.0-only'),
  },
  {
    label: 'BSD-3-Clause',
    getText: async () => licenseText(await loadLicenses(), 'BSD-3-Clause'),
  },
  {
    label: 'SPDX identifier',
    getText: () => 'SPDX-License-Identifier: MIT',
  },
  {
    label: 'Unknown text',
    getText: () =>
      'This README describes project setup, screenshots, and release notes. It is not a software license.',
  },
]

function button(label: string, className: string): HTMLButtonElement {
  const node = document.createElement('button')
  node.type = 'button'
  node.className = className
  node.textContent = label
  return node
}

function inputExceedsSizeLimit(text: string): boolean {
  return new Blob([text]).size > maxInputSize
}

function inputSegmentsExceedAnalysisLimit(parts: string[]): boolean {
  return new Blob(parts).size > maxInputSize
}

type PastedText =
  | { kind: 'missing-clipboard' }
  | { kind: 'plain-text'; text: string }
  | { kind: 'plain-text-unavailable' }

function readPastedText(clipboard: DataTransfer | null): PastedText {
  if (!clipboard) return { kind: 'missing-clipboard' }
  if (!Array.from(clipboard.types).includes('text/plain')) {
    return { kind: 'plain-text-unavailable' }
  }
  return { kind: 'plain-text', text: clipboard.getData('text/plain') }
}

function renderApp(): void {
  const app = requireElement<HTMLDivElement>('#app')
  app.className = 'min-h-screen'
  app.replaceChildren()

  const shell = document.createElement('main')
  shell.className =
    'mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8'

  const header = document.createElement('header')
  header.className =
    'grid gap-3 border-b border-stone-200 pb-5 md:grid-cols-[1fr_auto] md:items-end'
  const titleGroup = document.createElement('div')
  const title = document.createElement('h1')
  title.className = 'text-4xl font-bold tracking-normal text-stone-950'
  title.textContent = 'what-license'
  const subtitle = document.createElement('p')
  subtitle.className = 'mt-2 max-w-3xl text-base leading-7 text-stone-700'
  subtitle.textContent =
    'Privacy-friendly browser-only identification for likely open-source license text.'
  titleGroup.append(title, subtitle)
  const github = document.createElement('a')
  github.href = 'https://github.com/PeterDaveHello/what-license'
  github.className = 'text-sm font-semibold text-blue-700 hover:text-blue-900'
  github.textContent = 'GitHub'
  header.append(titleGroup, github)

  const workArea = document.createElement('section')
  workArea.className = 'grid gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]'
  const inputPanel = document.createElement('div')
  inputPanel.setAttribute('data-testid', 'drop-zone')
  inputPanel.className =
    'rounded-lg border border-stone-200 bg-white p-4 shadow-sm'
  const label = document.createElement('label')
  label.className = 'text-sm font-semibold text-stone-900'
  label.htmlFor = 'license-input'
  label.textContent = 'License text'
  const textarea = document.createElement('textarea')
  textarea.id = 'license-input'
  textarea.setAttribute('aria-describedby', 'license-input-error')
  textarea.className =
    'mt-3 min-h-80 w-full resize-y rounded-lg border border-stone-300 bg-white p-4 font-mono text-sm leading-6 text-stone-900 shadow-inner'
  textarea.placeholder =
    'Paste a license, SPDX identifier, source header, or drag a LICENSE file here.'
  const controls = document.createElement('div')
  controls.className = 'mt-3 flex flex-wrap gap-2'
  const secondaryClass =
    'rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold text-stone-800 hover:bg-stone-50'
  const clearButton = button('Clear', secondaryClass)
  controls.append(clearButton)
  inputPanel.append(label, textarea, controls)

  const sidePanel = document.createElement('aside')
  sidePanel.className = 'grid content-start gap-4'
  const samples = document.createElement('div')
  samples.className =
    'rounded-lg border border-stone-200 bg-white p-4 shadow-sm'
  const samplesTitle = document.createElement('h2')
  samplesTitle.className =
    'text-sm font-semibold uppercase tracking-wide text-stone-500'
  samplesTitle.textContent = 'Samples'
  const sampleList = document.createElement('div')
  sampleList.className = 'mt-3 grid gap-2'
  for (const sample of sampleInputs) {
    const sampleButton = button(sample.label, secondaryClass + ' text-left')
    sampleButton.addEventListener('click', async () => {
      const requestId = nextAsyncInputRequest()
      debouncedRun.cancel()
      try {
        const text = await sample.getText()
        if (requestId !== asyncInputRequestId) return
        textarea.value = text
        void runMatch()
        textarea.focus()
      } catch {
        if (requestId !== asyncInputRequestId) return
        renderErrorResponse(unableToLoadLicenseDataMessage)
      }
    })
    sampleList.append(sampleButton)
  }
  samples.append(samplesTitle, sampleList)

  const notes = document.createElement('div')
  notes.className =
    'rounded-lg border border-stone-200 bg-white p-4 text-sm leading-6 text-stone-700 shadow-sm'
  const privacy = document.createElement('p')
  privacy.textContent =
    'All matching runs locally in the browser. Pasted text is not uploaded to any server.'
  const disclaimer = document.createElement('p')
  disclaimer.className = 'mt-3'
  disclaimer.textContent =
    'This tool is for quick identification only and does not provide legal advice.'
  notes.append(privacy, disclaimer)
  sidePanel.append(samples, notes)
  workArea.append(inputPanel, sidePanel)

  const live = document.createElement('section')
  live.id = 'results'
  live.className = 'min-h-32'
  live.setAttribute('aria-live', 'polite')

  const error = document.createElement('p')
  error.id = 'license-input-error'
  error.className = 'text-sm font-medium text-red-700'
  error.hidden = true
  error.setAttribute('role', 'alert')

  shell.append(header, workArea, error, live)
  app.append(shell)

  function setError(
    message = '',
    { inputInvalid }: { inputInvalid?: boolean } = {},
  ): void {
    const hasError = Boolean(message)
    error.textContent = message
    error.hidden = !hasError
    if (inputInvalid === true) {
      textarea.setAttribute('aria-invalid', 'true')
    } else if (!hasError || inputInvalid === false) {
      textarea.removeAttribute('aria-invalid')
    }
  }

  function renderResultResponse(
    response: Parameters<typeof renderResponse>[1],
    options?: Parameters<typeof renderResponse>[2],
  ): void {
    live.setAttribute('aria-live', 'polite')
    renderResponse(live, response, options)
  }

  function renderErrorResponse(
    message: string,
    resultMessage = unableToAnalyzeInputMessage,
    { inputInvalid }: { inputInvalid?: boolean } = {},
  ): void {
    setError(message, { inputInvalid })
    live.setAttribute('aria-live', 'off')
    renderResponse(live, {
      inputType: 'unknown',
      results: [],
      message: resultMessage,
    })
  }

  function renderTooLargeInput(
    message = inputTooLargeMessage,
    { inputInvalid = true } = {},
  ): void {
    debouncedRun.cancel()
    renderErrorResponse(message, unableToAnalyzeInputMessage, {
      inputInvalid,
    })
  }

  async function runMatch(): Promise<void> {
    const requestId = asyncInputRequestId
    setError()
    const input = textarea.value
    if (inputExceedsSizeLimit(input)) {
      renderTooLargeInput()
      return
    }
    if (!input.trim()) {
      renderResultResponse(emptyInputResponse())
      return
    }
    let licenses: LicenseEntry[]
    try {
      licenses = await loadLicenses()
    } catch {
      if (requestId !== asyncInputRequestId || textarea.value !== input) return
      renderErrorResponse(unableToLoadLicenseDataMessage)
      return
    }
    if (requestId !== asyncInputRequestId || textarea.value !== input) return
    const response = rankLicenses(input, licenses, { includeDiffs: false })
    const shouldLoadDiffs =
      response.inputType === 'full-license-text' ||
      response.inputType === 'mixed-license-text'
    renderResultResponse(
      response,
      shouldLoadDiffs
        ? {
            loadDiff: (result, index) =>
              index < maxDiffResults
                ? diffForResult(input, result, licenses)
                : undefined,
            loadDiffSegments: (result, index) =>
              index < maxDiffResults
                ? diffSegmentsForResult(input, result, licenses)
                : undefined,
          }
        : undefined,
    )
  }

  const copyLabels = new WeakMap<HTMLElement, string>()
  const copyTimers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>()

  const debouncedRun = debounce(runMatch, inputDebounceMs)
  let asyncInputRequestId = 0
  function nextAsyncInputRequest(): number {
    asyncInputRequestId += 1
    return asyncInputRequestId
  }
  function invalidatePendingAsyncInput(): void {
    nextAsyncInputRequest()
  }
  textarea.addEventListener('input', () => {
    invalidatePendingAsyncInput()
    debouncedRun()
  })
  textarea.addEventListener('paste', (event) => {
    const paste = readPastedText(event.clipboardData)
    if (paste.kind === 'missing-clipboard') return
    if (paste.kind === 'plain-text-unavailable') {
      event.preventDefault()
      invalidatePendingAsyncInput()
      debouncedRun.cancel()
      void runMatch()
      setError(pastePlainTextUnavailableMessage)
      return
    }
    const clipboardText = paste.text
    if (!clipboardText) return
    invalidatePendingAsyncInput()

    const selectionStart = textarea.selectionStart ?? textarea.value.length
    const selectionEnd = textarea.selectionEnd ?? selectionStart
    const beforePaste = textarea.value.slice(0, selectionStart)
    const afterPaste = textarea.value.slice(selectionEnd)
    if (
      !inputSegmentsExceedAnalysisLimit([
        beforePaste,
        clipboardText,
        afterPaste,
      ])
    ) {
      if (error.textContent === pasteTooLargeMessage) setError()
      return
    }

    event.preventDefault()
    debouncedRun.cancel()
    if (inputExceedsSizeLimit(textarea.value)) {
      renderTooLargeInput(pasteTooLargeMessage)
      return
    }
    void runMatch()
    setError(pasteTooLargeMessage)
  })
  clearButton.addEventListener('click', () => {
    invalidatePendingAsyncInput()
    textarea.value = ''
    void runMatch()
    textarea.focus()
  })
  live.addEventListener('click', async (event) => {
    const eventTarget = event.target
    const elementTarget =
      eventTarget instanceof Element
        ? eventTarget
        : eventTarget instanceof Node
          ? eventTarget.parentElement
          : undefined
    const copyTarget = elementTarget?.closest<HTMLElement>('[data-copy]')
    if (!copyTarget || !live.contains(copyTarget)) return
    const value = copyTarget.dataset.copy
    if (!value) return
    try {
      await writeClipboardText(value)
      const originalText =
        copyLabels.get(copyTarget) || copyTarget.textContent || 'Copy SPDX ID'
      const previousTimer = copyTimers.get(copyTarget)
      if (previousTimer !== undefined) clearTimeout(previousTimer)
      copyLabels.set(copyTarget, originalText)
      copyTarget.textContent = 'Copied'
      copyTimers.set(
        copyTarget,
        setTimeout(() => {
          copyTarget.textContent = originalText
          copyLabels.delete(copyTarget)
          copyTimers.delete(copyTarget)
        }, 1200),
      )
    } catch (clipboardError) {
      setError(
        clipboardError instanceof Error
          ? clipboardError.message
          : 'Unable to write clipboard.',
      )
    }
  })

  const unbindFileDrop = bindFileDrop(
    inputPanel,
    (text) => {
      textarea.value = text
      void runMatch()
    },
    (message) => {
      const inputInvalid = inputExceedsSizeLimit(textarea.value)
      if (message === inputTooLargeMessage) {
        renderTooLargeInput(droppedFileTooLargeResultMessage, {
          inputInvalid,
        })
        return
      }
      if (textarea.value.trim() && !inputInvalid) {
        debouncedRun.cancel()
        void runMatch()
        setError(message, { inputInvalid: false })
        return
      }
      renderErrorResponse(message, 'Unable to analyze dropped file.', {
        inputInvalid,
      })
    },
    () => {
      const requestId = nextAsyncInputRequest()
      debouncedRun.cancel()
      return requestId
    },
    (requestId) => requestId === asyncInputRequestId,
    inputExceedsSizeLimit,
  )

  if (import.meta.hot) {
    import.meta.hot.dispose(unbindFileDrop)
  }

  void runMatch()
}

renderApp()
