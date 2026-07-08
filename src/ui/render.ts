import { maxDiffResults } from '../core/constants'
import type { DiffSegment, MatchResponse, MatchResult } from '../core/types'

export interface RenderOptions {
  loadDiff?: (result: MatchResult, index: number) => string | undefined
  loadDiffSegments?: (
    result: MatchResult,
    index: number,
  ) => DiffSegment[] | undefined
}

function element<K extends keyof HTMLElementTagNameMap>(
  tagName: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tagName)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function formatScore(value: number): string {
  return Math.round(value * 1000) / 10 + '%'
}

function confidenceClass(confidence: MatchResult['confidence']): string {
  if (confidence === 'Exact')
    return 'bg-emerald-100 text-emerald-900 border-emerald-300'
  if (confidence === 'Likely') return 'bg-sky-100 text-sky-900 border-sky-300'
  if (confidence === 'Possible')
    return 'bg-amber-100 text-amber-900 border-amber-300'
  return 'bg-stone-100 text-stone-800 border-stone-300'
}

function pill(
  text: string,
  className = 'bg-white text-stone-700 border-stone-300',
): HTMLElement {
  return element(
    'span',
    'inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-semibold ' +
      className,
    text,
  )
}

function metadata(label: string, value: string): HTMLElement {
  const wrapper = element('div', 'min-w-0')
  wrapper.append(
    element(
      'div',
      'text-xs font-semibold uppercase tracking-wide text-stone-500',
      label,
    ),
    element('div', 'truncate text-sm font-medium text-stone-900', value),
  )
  return wrapper
}

function diffSegmentNode(segment: DiffSegment): HTMLElement | Text {
  if (segment.type === 'equal') {
    return document.createTextNode(segment.text)
  }

  const node = document.createElement(segment.type === 'insert' ? 'ins' : 'del')
  node.className =
    segment.type === 'insert'
      ? 'rounded bg-emerald-100 px-1 font-medium text-emerald-900 no-underline'
      : 'rounded bg-red-100 px-1 font-medium text-red-900 line-through'
  node.textContent = (segment.type === 'insert' ? '+ ' : '- ') + segment.text
  return node
}

function renderDiffSummary(
  container: HTMLElement,
  segments?: DiffSegment[],
  fallbackText = '',
): boolean {
  container.replaceChildren()
  if (segments && segments.length > 0) {
    for (const [index, segment] of segments.entries()) {
      if (index > 0) container.append(document.createTextNode(' '))
      container.append(diffSegmentNode(segment))
    }
    return segments.some((segment) => segment.type !== 'equal')
  }
  container.textContent = fallbackText
  return false
}

function resultCard(
  result: MatchResult,
  index: number,
  options: RenderOptions,
): HTMLElement {
  const card = element(
    'article',
    'rounded-lg border border-stone-200 bg-white p-4 shadow-sm',
  )
  const header = element(
    'div',
    'flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between',
  )
  const titleGroup = element('div', 'min-w-0')
  titleGroup.append(
    element('h3', 'truncate text-lg font-semibold text-stone-950', result.name),
    element('p', 'mt-1 text-sm text-stone-600', result.explanation),
  )

  const copyButton = element(
    'button',
    'inline-flex shrink-0 items-center justify-center rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold text-stone-800 hover:bg-stone-50',
    'Copy SPDX ID',
  )
  copyButton.type = 'button'
  copyButton.dataset.copy = result.licenseId
  header.append(titleGroup, copyButton)

  const pills = element('div', 'mt-4 flex flex-wrap gap-2')
  pills.append(
    pill(result.licenseId, 'bg-stone-950 text-white border-stone-950'),
    pill(result.confidence, confidenceClass(result.confidence)),
    pill(result.inputType),
  )
  if (result.flags.isOsiApproved)
    pills.append(
      pill('OSI approved', 'bg-emerald-50 text-emerald-900 border-emerald-200'),
    )
  if (result.flags.isFsfLibre)
    pills.append(
      pill('FSF libre', 'bg-indigo-50 text-indigo-900 border-indigo-200'),
    )
  if (result.flags.needsManualReview)
    pills.append(
      pill('Manual review', 'bg-amber-50 text-amber-900 border-amber-200'),
    )
  if (result.flags.isDeprecated || result.flags.isLegacyId)
    pills.append(
      pill('Legacy warning', 'bg-red-50 text-red-900 border-red-200'),
    )

  const scores = element('div', 'mt-4 grid gap-3 sm:grid-cols-3')
  scores.append(
    metadata('F1 score', formatScore(result.score.f1)),
    metadata('Precision', formatScore(result.score.precision)),
    metadata('Recall', formatScore(result.score.recall)),
  )

  card.append(header, pills, scores)

  const hasEagerDiff =
    result.diff !== undefined || result.diffSegments !== undefined
  const hasVisibleEagerDiff = Boolean(
    result.diff || (result.diffSegments && result.diffSegments.length > 0),
  )
  const canLoadLazyDiff =
    !hasEagerDiff &&
    Boolean(options.loadDiff || options.loadDiffSegments) &&
    index < maxDiffResults
  if (hasVisibleEagerDiff || canLoadLazyDiff) {
    const details = element(
      'details',
      'mt-4 rounded-md border border-stone-200 bg-stone-50 p-3',
    )
    const diffText = element(
      'div',
      'diff-text mt-2 text-sm leading-7 text-stone-700',
    )
    const diffLegend = element(
      'p',
      'mt-2 text-xs text-stone-600',
      'Green text is in the matched license; red text is extra in the input.',
    )
    diffLegend.hidden = !renderDiffSummary(
      diffText,
      result.diffSegments,
      result.diff || '',
    )
    let loaded = hasEagerDiff
    details.addEventListener('toggle', () => {
      if (
        !details.open ||
        loaded ||
        (!options.loadDiff && !options.loadDiffSegments)
      )
        return
      try {
        const segments = options.loadDiffSegments?.(result, index)
        diffLegend.hidden = !renderDiffSummary(
          diffText,
          segments,
          segments && segments.length > 0
            ? ''
            : options.loadDiff?.(result, index) || '',
        )
        loaded = true
      } catch {
        diffText.textContent = 'Unable to load diff summary.'
        loaded = true
      }
    })
    details.append(
      element(
        'summary',
        'cursor-pointer text-sm font-semibold text-stone-800',
        'Diff summary',
      ),
      diffLegend,
      diffText,
    )
    card.append(details)
  }

  return card
}

export function renderResponse(
  container: HTMLElement,
  response: MatchResponse,
  options: RenderOptions = {},
): void {
  container.replaceChildren()
  const status = element(
    'div',
    'rounded-lg border border-stone-200 bg-white p-4 shadow-sm',
  )
  status.append(
    element('p', 'text-sm font-semibold text-stone-950', response.message),
    element(
      'p',
      'mt-1 text-sm text-stone-600',
      'Input type: ' + response.inputType,
    ),
  )
  if (response.spdxExpression) {
    status.append(
      element(
        'p',
        'mt-2 text-sm text-stone-700',
        'SPDX expression: ' + response.spdxExpression,
      ),
    )
  }
  if (response.legacyAlias) {
    status.append(
      element(
        'p',
        'mt-2 text-sm font-medium text-amber-800',
        response.legacyAlias.message,
      ),
    )
  }
  container.append(status)

  if (response.results.length === 0) return

  const list = element('div', 'mt-4 grid gap-4')
  response.results.forEach((result, index) => {
    list.append(resultCard(result, index, options))
  })
  container.append(list)
}
