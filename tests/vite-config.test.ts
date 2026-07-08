import { describe, expect, it } from 'vitest'
import config from '../vite.config'

interface CspPlugin {
  name: string
  configResolved?: (config: { server: TestServerConfig }) => void
  transformIndexHtml: (html: string) => string
}

interface TestServerConfig {
  hmr?:
    | boolean
    | {
        clientPort?: number
        host?: string
        port?: number
      }
  host?: boolean | string
  port?: number
}

function isCspPlugin(candidate: unknown): candidate is CspPlugin {
  if (!candidate || typeof candidate !== 'object') return false
  const plugin = candidate as Partial<CspPlugin>
  return (
    plugin.name === 'what-license-csp' &&
    typeof plugin.transformIndexHtml === 'function'
  )
}

function cspTransform(
  command: 'serve' | 'build' = 'serve',
  mode = command === 'build' ? 'production' : 'development',
  server?: TestServerConfig,
  isPreview = false,
): (html: string) => string {
  const configFactory = config as (env: {
    command: 'serve' | 'build'
    isPreview?: boolean
    mode: string
  }) => { plugins?: unknown[] }
  const resolved = configFactory({
    command,
    isPreview,
    mode,
  })
  const plugin = (resolved.plugins || []).flat().find(isCspPlugin)
  if (!plugin) throw new Error('Missing CSP plugin')
  if (server) plugin.configResolved?.({ server })
  return plugin.transformIndexHtml
}

describe('Vite/Vitest config', () => {
  it('sets a stable unit test timeout budget', () => {
    const configFactory = config as (env: {
      command: 'serve' | 'build'
      mode: string
    }) => { test?: { testTimeout?: number } }

    expect(
      configFactory({ command: 'serve', mode: 'development' }).test
        ?.testTimeout,
    ).toBe(15_000)
  })
})

describe('Vite CSP injection', () => {
  it('includes form-submit protection', () => {
    expect(cspTransform()('<head></head>')).toContain("form-action 'none'")
  })

  it('does not claim frame embedding protection through meta CSP', () => {
    expect(cspTransform()('<head></head>')).not.toContain('frame-ancestors')
  })

  it('keeps default dev HMR websockets scoped to loopback hosts', () => {
    const html = cspTransform('serve')('<head></head>')

    expect(html).toContain("connect-src 'self'")
    expect(html).toContain('ws://localhost:*')
    expect(html).toContain('wss://localhost:*')
    expect(html).toContain('ws://127.0.0.1:*')
    expect(html).toContain('wss://127.0.0.1:*')
    expect(html).toContain('ws://[::1]:*')
    expect(html).toContain('wss://[::1]:*')
    expect(html).not.toContain("connect-src 'self' ws: wss:")
    expect(html).toContain("style-src 'self' 'unsafe-inline'")
  })

  it('allows a configured dev host without opening every websocket origin', () => {
    const html = cspTransform('serve', 'development', {
      host: '192.0.2.10',
      port: 5174,
    })('<head></head>')

    expect(html).toContain('ws://192.0.2.10:5174')
    expect(html).toContain('wss://192.0.2.10:5174')
    expect(html).not.toContain("connect-src 'self' ws: wss:")
  })

  it('limits wildcard dev hosts to the resolved dev port', () => {
    const html = cspTransform('serve', 'development', {
      host: true,
      port: 5174,
    })('<head></head>')

    expect(html).toContain('ws://*:5174')
    expect(html).toContain('wss://*:5174')
    expect(html).not.toContain("connect-src 'self' ws: wss:")
  })

  it('limits wildcard address dev hosts to the resolved dev port', () => {
    const html = cspTransform('serve', 'development', {
      host: '0.0.0.0',
      port: 5174,
    })('<head></head>')

    expect(html).toContain('ws://*:5174')
    expect(html).toContain('wss://*:5174')
    expect(html).not.toContain("connect-src 'self' ws: wss:")
  })

  it('uses configured HMR host and client port for dev CSP', () => {
    const html = cspTransform('serve', 'development', {
      hmr: {
        clientPort: 24678,
        host: 'dev.example.test',
      },
      host: '0.0.0.0',
      port: 5174,
    })('<head></head>')

    expect(html).toContain('ws://dev.example.test:24678')
    expect(html).toContain('wss://dev.example.test:24678')
    expect(html).not.toContain('ws://*:5174')
    expect(html).not.toContain("connect-src 'self' ws: wss:")
  })

  it('treats zero-valued dev HMR ports as unset in CSP sources', () => {
    const html = cspTransform('serve', 'development', {
      hmr: {
        clientPort: 0,
        host: 'dev.example.test',
        port: 24678,
      },
      port: 5174,
    })('<head></head>')

    expect(html).toContain('ws://dev.example.test:24678')
    expect(html).toContain('wss://dev.example.test:24678')
    expect(html).not.toContain('ws://dev.example.test:0')
    expect(html).not.toContain('ws://dev.example.test:5174')
  })

  it('escapes CSP content when dev hosts contain attribute characters', () => {
    const html = cspTransform('serve', 'development', {
      hmr: {
        clientPort: 24678,
        host: 'dev.example.test"&<>',
      },
    })('<head></head>')

    expect(html).toContain('dev.example.test&quot;&amp;&lt;&gt;:24678')
    expect(html).not.toContain('dev.example.test"&<>:24678')
  })

  it('uses dev CSP for serve even when mode is production', () => {
    const html = cspTransform('serve', 'production')('<head></head>')

    expect(html).toContain('ws://localhost:*')
    expect(html).toContain("style-src 'self' 'unsafe-inline'")
  })

  it('keeps preview websocket connections restricted', () => {
    const html = cspTransform(
      'serve',
      'production',
      undefined,
      true,
    )('<head></head>')

    expect(html).toContain("connect-src 'self'")
    expect(html).not.toContain('ws:')
    expect(html).not.toContain('wss:')
    expect(html).not.toContain('unsafe-inline')
  })

  it('keeps production websocket connections restricted', () => {
    const html = cspTransform('build')('<head></head>')

    expect(html).toContain("connect-src 'self'")
    expect(html).not.toContain('ws:')
    expect(html).not.toContain('wss:')
  })

  it('falls back without throwing when no head tag exists', () => {
    expect(cspTransform()('<html><body></body></html>')).toContain(
      '<meta http-equiv="Content-Security-Policy"',
    )
  })

  it('keeps doctype first in fallback CSP injection', () => {
    const transformed = cspTransform()(
      '<!doctype html><html><body></body></html>',
    )

    expect(transformed).toMatch(/^<!doctype html>/i)
    expect(transformed).toContain('<head>')
    expect(transformed).toContain('<meta http-equiv="Content-Security-Policy"')
  })

  it('injects the CSP meta tag into uppercase head tags', () => {
    const html = '<HTML><HEAD></HEAD><BODY></BODY></HTML>'

    expect(cspTransform()(html)).toContain(
      '<meta http-equiv="Content-Security-Policy"',
    )
  })

  it('keeps charset before the injected CSP meta tag', () => {
    const transformed = cspTransform()(
      '<head><meta charset="UTF-8"><title>what-license</title></head>',
    )

    expect(transformed.indexOf('<meta charset="UTF-8">')).toBeLessThan(
      transformed.indexOf('<meta http-equiv="Content-Security-Policy"'),
    )
  })

  it('uses the matched head tag instead of an earlier identical string', () => {
    const transformed = cspTransform()(
      '<!-- <head> --><html><head><title>what-license</title></head></html>',
    )

    expect(transformed).toContain(
      '<!-- <head> --><html><head>\n    <meta http-equiv="Content-Security-Policy"',
    )
  })

  it('uses the matched html tag when injecting a missing head', () => {
    const transformed = cspTransform()(
      '<!-- <html> --><html><body>what-license</body></html>',
    )

    expect(transformed).toContain(
      '<!-- <html> --><html>\n<head>\n<meta http-equiv="Content-Security-Policy"',
    )
  })

  it('ignores charset meta tags outside the head', () => {
    const transformed = cspTransform()(
      '<head><title>what-license</title></head><body><meta charset="UTF-8"></body>',
    )

    expect(
      transformed.indexOf('<meta http-equiv="Content-Security-Policy"'),
    ).toBeLessThan(transformed.indexOf('</head>'))
  })

  it('ignores charset meta tags inside comments and raw text', () => {
    for (const wrapper of [
      '<!-- <meta charset="UTF-8"> -->',
      '<script>const sample = `<meta charset="UTF-8">`;</script>',
      '<style>body::before { content: "<meta charset=\'UTF-8\'>"; }</style>',
    ]) {
      const transformed = cspTransform()(
        wrapper + '<head><title>x</title></head>',
      )

      expect(transformed).toContain(
        '<head>\n    <meta http-equiv="Content-Security-Policy"',
      )
    }
  })

  it('ignores head close tags inside raw text', () => {
    const transformed = cspTransform()(
      '<head><script>const sample = "</head>";</script><title>x</title></head>',
    )

    expect(
      transformed.indexOf('<meta http-equiv="Content-Security-Policy"'),
    ).toBeLessThan(transformed.indexOf('<title>x</title>'))
  })

  it('does not duplicate an existing CSP meta tag with spaced attributes', () => {
    const html =
      '<head><meta http-equiv = "Content-Security-Policy" content="default-src none"></head>'

    expect(cspTransform()(html)).toBe(html)
  })

  it('replaces CSP meta tags without an enforcing policy', () => {
    for (const tag of [
      '<meta http-equiv="Content-Security-Policy">',
      '<meta http-equiv="Content-Security-Policy" content>',
      '<meta http-equiv="Content-Security-Policy" content="">',
      '<meta http-equiv="Content-Security-Policy" content="   ">',
    ]) {
      const transformed = cspTransform()('<head>' + tag + '</head>')

      expect(transformed).toContain(
        '<meta http-equiv="Content-Security-Policy" content="default-src',
      )
      expect(transformed).not.toBe('<head>' + tag + '</head>')
      const cspTags =
        transformed.match(
          /<meta\b[^>]*http-equiv="Content-Security-Policy"[^>]*>/g,
        ) ?? []
      expect(cspTags).toHaveLength(1)
      expect(cspTags[0]).toContain('default-src')
    }
  })

  it('keeps charset before a replaced CSP meta tag', () => {
    const transformed = cspTransform()(
      '<head><meta http-equiv="Content-Security-Policy"><meta name="viewport" content="width=device-width"><meta charset="UTF-8"><title>x</title></head>',
    )
    const cspTags =
      transformed.match(
        /<meta\b[^>]*http-equiv="Content-Security-Policy"[^>]*>/g,
      ) ?? []

    expect(cspTags).toHaveLength(1)
    expect(transformed).toContain(
      '<meta name="viewport" content="width=device-width"><meta charset="UTF-8">',
    )
    expect(transformed.indexOf('<meta charset="UTF-8">')).toBeLessThan(
      transformed.indexOf(cspTags[0] ?? ''),
    )
    expect(transformed).not.toContain(
      '<meta http-equiv="Content-Security-Policy"><meta charset="UTF-8">',
    )
  })

  it('replaces a CSP meta placeholder after charset in place', () => {
    const transformed = cspTransform()(
      '<head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy"><title>x</title></head>',
    )
    const cspTags =
      transformed.match(
        /<meta\b[^>]*http-equiv="Content-Security-Policy"[^>]*>/g,
      ) ?? []

    expect(cspTags).toHaveLength(1)
    expect(transformed.indexOf('<meta charset="UTF-8">')).toBeLessThan(
      transformed.indexOf(cspTags[0] ?? ''),
    )
    expect(transformed).toContain(
      '<meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src',
    )
  })

  it('does not treat CSP text inside another attribute as enforcing', () => {
    const transformed = cspTransform()(
      '<head><meta name="description" content="Set http-equiv=Content-Security-Policy to enable CSP"></head>',
    )

    expect(transformed).toContain(
      '<meta http-equiv="Content-Security-Policy" content="default-src',
    )
  })

  it('ignores CSP meta tags outside the head', () => {
    const transformed = cspTransform()(
      '<head><title>x</title></head><body><meta http-equiv="Content-Security-Policy" content="default-src none"></body>',
    )

    expect(
      transformed.indexOf('<meta http-equiv="Content-Security-Policy"'),
    ).toBeLessThan(transformed.indexOf('<title>x</title>'))
  })

  it('ignores CSP meta tags inside comments and raw text', () => {
    for (const wrapper of [
      '<!-- <meta http-equiv="Content-Security-Policy" content="default-src none"> -->',
      '<script>const sample = `<meta http-equiv="Content-Security-Policy" content="default-src none">`</script>',
      '<style>meta::before { content: "<meta http-equiv=\'Content-Security-Policy\'>"; }</style>',
    ]) {
      const transformed = cspTransform()(wrapper + '<head></head>')

      expect(transformed).toContain(
        '<head>\n    <meta http-equiv="Content-Security-Policy"',
      )
    }
  })

  it('does not let commented raw text tags hide a real CSP meta tag', () => {
    for (const comment of ['<!-- <script> -->', '<!-- <style> -->']) {
      const html =
        comment +
        '<head><meta http-equiv="Content-Security-Policy" content="default-src none"></head>'

      expect(cspTransform()(html)).toBe(html)
    }
  })

  it('does not let raw text samples hide a real CSP meta tag', () => {
    for (const wrapper of [
      '<head><script>const sample = "<style>";</script>',
      '<head><style>body::before { content: "<script>"; }</style>',
    ]) {
      const html =
        wrapper +
        '<meta http-equiv="Content-Security-Policy" content="default-src none"></head>'

      expect(cspTransform()(html)).toBe(html)
    }
  })

  it('does not let raw text comment samples hide a real CSP meta tag', () => {
    for (const wrapper of [
      '<head><script>const sample = "<!--";</script>',
      '<head><style>body::before { content: "<!--"; }</style>',
    ]) {
      const html =
        wrapper +
        '<meta http-equiv="Content-Security-Policy" content="default-src none"></head>'

      expect(cspTransform()(html)).toBe(html)
    }
  })

  it('does not treat report-only CSP as an enforcing CSP meta tag', () => {
    const html =
      '<head><meta http-equiv="Content-Security-Policy-Report-Only" content="default-src none"></head>'

    expect(cspTransform()(html)).toContain(
      '<meta http-equiv="Content-Security-Policy"',
    )
  })

  it('does not treat legacy CSP headers as enforcing CSP meta tags', () => {
    const html =
      '<head><meta http-equiv="X-Content-Security-Policy" content="default-src none"></head>'

    expect(cspTransform()(html)).toContain(
      '<meta http-equiv="Content-Security-Policy"',
    )
  })

  it('does not treat data-http-equiv as an existing CSP meta tag', () => {
    const html =
      '<head><meta data-http-equiv="Content-Security-Policy" content="not a CSP"></head>'

    expect(cspTransform()(html)).toContain(
      '<meta http-equiv="Content-Security-Policy"',
    )
  })
})
