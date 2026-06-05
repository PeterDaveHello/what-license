import tailwindcss from '@tailwindcss/vite'
import type { ResolvedConfig } from 'vite'
import { defineConfig } from 'vitest/config'

function cspHost(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? '[' + host + ']' : host
}

function addWebSocketSources(
  sources: Set<string>,
  host: string,
  port = '*',
): void {
  const sourceHost = cspHost(host)
  sources.add('ws://' + sourceHost + ':' + port)
  sources.add('wss://' + sourceHost + ':' + port)
}

function devWebSocketPort(config: ResolvedConfig | undefined): string {
  const hmr = config?.server.hmr
  if (hmr && typeof hmr === 'object') {
    return String(hmr.clientPort || hmr.port || config?.server.port || 5173)
  }
  return String(config?.server.port || 5173)
}

function devConnectSrc(config: ResolvedConfig | undefined): string {
  const sources = new Set(["'self'"])
  for (const host of ['localhost', '127.0.0.1', '::1']) {
    addWebSocketSources(sources, host)
  }

  const hmr = config?.server.hmr
  const hmrHost = hmr && typeof hmr === 'object' ? hmr.host : undefined
  const serverHost = hmrHost || config?.server.host
  if (typeof serverHost === 'string') {
    if (serverHost === '0.0.0.0' || serverHost === '::') {
      addWebSocketSources(sources, '*', devWebSocketPort(config))
    } else {
      addWebSocketSources(sources, serverHost, devWebSocketPort(config))
    }
  } else if (serverHost === true) {
    addWebSocketSources(sources, '*', devWebSocketPort(config))
  }

  return 'connect-src ' + Array.from(sources).join(' ')
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

interface HtmlRange {
  start: number
  end: number
}

interface HtmlScanContext {
  commentRanges: HtmlRange[]
  rawTextRanges: HtmlRange[]
}

interface CspMetaScanResult {
  hasEnforcingTag: boolean
  firstNonEnforcingTag?: HtmlRange
}

function isInsideRanges(ranges: HtmlRange[], index: number): boolean {
  let low = 0
  let high = ranges.length - 1
  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    const range = ranges[mid]
    if (!range) return false
    if (index < range.start) {
      high = mid - 1
    } else if (index >= range.end) {
      low = mid + 1
    } else {
      return true
    }
  }
  return false
}

function htmlScanContext(html: string): HtmlScanContext {
  const commentRanges: HtmlRange[] = []
  const rawTextRanges: HtmlRange[] = []
  const tokenPattern = /<!--|-->|<\/?(script|style)\b[^>]*>/gi
  let openCommentStart = -1
  let openRawTextStart = -1
  let openRawTextTagName: 'script' | 'style' | undefined
  for (const match of html.matchAll(tokenPattern)) {
    const index = match.index ?? 0
    const token = match[0]
    const tagName = match[1]?.toLowerCase() as 'script' | 'style' | undefined

    if (openRawTextStart >= 0) {
      if (/^<\//.test(token) && tagName === openRawTextTagName) {
        rawTextRanges.push({
          start: openRawTextStart,
          end: index + token.length,
        })
        openRawTextStart = -1
        openRawTextTagName = undefined
      }
      continue
    }

    if (openCommentStart >= 0) {
      if (token === '-->') {
        commentRanges.push({ start: openCommentStart, end: index + 3 })
        openCommentStart = -1
      }
      continue
    }

    if (token === '<!--') {
      openCommentStart = index
    } else if (tagName && !/^<\//.test(token)) {
      openRawTextStart = index
      openRawTextTagName = tagName
    }
  }
  if (openCommentStart >= 0)
    commentRanges.push({ start: openCommentStart, end: html.length })
  if (openRawTextStart >= 0)
    rawTextRanges.push({ start: openRawTextStart, end: html.length })
  return { commentRanges, rawTextRanges }
}

function isInsideIgnoredHtml(context: HtmlScanContext, index: number): boolean {
  return (
    isInsideRanges(context.commentRanges, index) ||
    isInsideRanges(context.rawTextRanges, index)
  )
}

function headTagMatch(
  html: string,
  context: HtmlScanContext,
): RegExpMatchArray | undefined {
  for (const match of html.matchAll(/<head\b[^>]*>/gi)) {
    const index = match.index ?? 0
    if (isInsideIgnoredHtml(context, index)) continue
    return match
  }
  return undefined
}

function htmlTagMatch(
  html: string,
  context: HtmlScanContext,
): RegExpMatchArray | undefined {
  for (const match of html.matchAll(/<html\b[^>]*>/gi)) {
    const index = match.index ?? 0
    if (isInsideIgnoredHtml(context, index)) continue
    return match
  }
  return undefined
}

function htmlAttributeValue(tag: string, name: string): string | undefined {
  const attributePattern =
    /\s([^\s=/"'>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g
  for (const match of tag.matchAll(attributePattern)) {
    if (match[1].toLowerCase() === name) {
      return match[2] ?? match[3] ?? match[4] ?? ''
    }
  }
  return undefined
}

function cspMetaScanResult(
  html: string,
  context: HtmlScanContext,
  startIndex: number,
  endIndex: number,
): CspMetaScanResult {
  const metaTagPattern = /<meta\b[^>]*>/gi
  metaTagPattern.lastIndex = startIndex
  let firstNonEnforcingTag: HtmlRange | undefined
  let match: RegExpExecArray | null
  while ((match = metaTagPattern.exec(html))) {
    const index = match.index ?? 0
    if (index >= endIndex) break
    if (isInsideIgnoredHtml(context, index)) continue
    if (
      htmlAttributeValue(match[0], 'http-equiv')?.trim().toLowerCase() !==
      'content-security-policy'
    )
      continue
    if (htmlAttributeValue(match[0], 'content')?.trim()) {
      return { hasEnforcingTag: true }
    }
    firstNonEnforcingTag ??= { start: index, end: index + match[0].length }
  }
  return { hasEnforcingTag: false, firstNonEnforcingTag }
}

function headCloseIndex(
  html: string,
  context: HtmlScanContext,
  startIndex: number,
): number | undefined {
  const headClosePattern = /<\/head\s*>/gi
  headClosePattern.lastIndex = startIndex
  let match: RegExpExecArray | null
  while ((match = headClosePattern.exec(html))) {
    const index = match.index
    if (isInsideIgnoredHtml(context, index)) continue
    return index
  }
  return undefined
}

function charsetMetaEndIndex(
  html: string,
  context: HtmlScanContext,
  startIndex: number,
  endIndex: number,
): number | undefined {
  const charsetMetaPattern = /<meta\b(?=[^>]*\scharset\s*=)[^>]*>/gi
  charsetMetaPattern.lastIndex = startIndex
  let match: RegExpExecArray | null
  while ((match = charsetMetaPattern.exec(html))) {
    const index = match.index
    if (index >= endIndex) break
    if (isInsideIgnoredHtml(context, index)) continue
    return index + match[0].length
  }
  return undefined
}

export default defineConfig(({ command, isPreview }) => {
  let resolvedConfig: ResolvedConfig | undefined

  return {
    base: './',
    plugins: [
      tailwindcss(),
      {
        name: 'what-license-csp',
        configResolved(config) {
          resolvedConfig = config
        },
        transformIndexHtml(html) {
          const scanContext = htmlScanContext(html)
          const usesDevCsp = command === 'serve' && !isPreview
          const styleSrc = usesDevCsp
            ? "style-src 'self' 'unsafe-inline'"
            : "style-src 'self'"
          const connectSrc = usesDevCsp
            ? devConnectSrc(resolvedConfig)
            : "connect-src 'self'"
          // frame-ancestors and sandbox require real HTTP headers; GitHub
          // Pages can only receive this app's CSP through a meta tag.
          const csp = [
            "default-src 'self'",
            "script-src 'self'",
            styleSrc,
            connectSrc,
            "img-src 'self'",
            "object-src 'none'",
            "base-uri 'self'",
            "form-action 'none'",
          ].join('; ')
          const cspTag =
            '    <meta http-equiv="Content-Security-Policy" content="' +
            escapeHtmlAttribute(csp) +
            '" />'

          const headMatch = headTagMatch(html, scanContext)

          if (!headMatch) {
            const htmlMatch = htmlTagMatch(html, scanContext)
            const fallbackHead = '<head>\n' + cspTag.trimStart() + '\n</head>'
            if (htmlMatch) {
              const htmlTag = htmlMatch[0]
              const htmlEndIndex = (htmlMatch.index ?? 0) + htmlTag.length
              return (
                html.slice(0, htmlEndIndex) +
                '\n' +
                fallbackHead +
                html.slice(htmlEndIndex)
              )
            }

            const doctype = html.match(/^\s*<!doctype\b[^>]*>/i)?.[0]
            if (doctype)
              return html.replace(doctype, () => doctype + '\n' + fallbackHead)
            return fallbackHead + '\n' + html
          }

          const headTag = headMatch[0]
          const headIndex = headMatch.index ?? 0
          const headEndIndex = headIndex + headTag.length
          const headContentEndIndex =
            headCloseIndex(html, scanContext, headEndIndex) ?? html.length
          const charsetEndIndex = charsetMetaEndIndex(
            html,
            scanContext,
            headEndIndex,
            headContentEndIndex,
          )
          const cspMetaScan = cspMetaScanResult(
            html,
            scanContext,
            headEndIndex,
            headContentEndIndex,
          )
          if (cspMetaScan.hasEnforcingTag) return html
          if (cspMetaScan.firstNonEnforcingTag) {
            if (
              charsetEndIndex !== undefined &&
              cspMetaScan.firstNonEnforcingTag.start < charsetEndIndex
            ) {
              return (
                html.slice(0, cspMetaScan.firstNonEnforcingTag.start) +
                html.slice(
                  cspMetaScan.firstNonEnforcingTag.end,
                  charsetEndIndex,
                ) +
                '\n' +
                cspTag +
                html.slice(charsetEndIndex)
              )
            }
            return (
              html.slice(0, cspMetaScan.firstNonEnforcingTag.start) +
              cspTag.trimStart() +
              html.slice(cspMetaScan.firstNonEnforcingTag.end)
            )
          }
          if (charsetEndIndex !== undefined) {
            return (
              html.slice(0, charsetEndIndex) +
              '\n' +
              cspTag +
              html.slice(charsetEndIndex)
            )
          }

          return (
            html.slice(0, headEndIndex) +
            '\n' +
            cspTag +
            html.slice(headEndIndex)
          )
        },
      },
    ],
    test: {
      environment: 'jsdom',
      include: ['tests/**/*.test.ts'],
      testTimeout: 15_000,
    },
  }
})
