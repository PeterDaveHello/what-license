import { describe, expect, it } from 'vitest'
import { isCiEnvironment, resolveWebServerSettings } from '../playwright.config'

describe('Playwright CI detection', () => {
  it('treats unset and explicit false CI values as local runs', () => {
    expect(isCiEnvironment(undefined)).toBe(false)
    expect(isCiEnvironment('')).toBe(false)
    expect(isCiEnvironment(' ')).toBe(false)
    expect(isCiEnvironment('0')).toBe(false)
    expect(isCiEnvironment(' 0 ')).toBe(false)
    expect(isCiEnvironment('false')).toBe(false)
    expect(isCiEnvironment(' false ')).toBe(false)
  })

  it('treats other CI values as CI runs', () => {
    expect(isCiEnvironment('1')).toBe(true)
    expect(isCiEnvironment('true')).toBe(true)
    expect(isCiEnvironment('yes')).toBe(true)
  })
})

describe('Playwright web server config', () => {
  it('uses the default Vite port when a custom URL omits the port', () => {
    const settings = resolveWebServerSettings({
      PLAYWRIGHT_WEB_SERVER_URL: 'http://127.0.0.1',
    })

    expect(settings.url).toBe('http://127.0.0.1:5173/')
    expect(settings.command).toBe(
      'npm run dev -- --host 127.0.0.1 --port 5173 --strictPort',
    )
  })

  it('uses explicit custom URL ports for the default dev command', () => {
    const settings = resolveWebServerSettings({
      PLAYWRIGHT_WEB_SERVER_URL: 'http://localhost:5174',
    })

    expect(settings.url).toBe('http://localhost:5174/')
    expect(settings.command).toBe(
      'npm run dev -- --host localhost --port 5174 --strictPort',
    )
  })

  it('keeps custom commands as the source of truth', () => {
    const settings = resolveWebServerSettings({
      PLAYWRIGHT_WEB_SERVER_COMMAND:
        'npm run dev -- --host 0.0.0.0 --port 5174 --strictPort',
      PLAYWRIGHT_WEB_SERVER_URL: 'http://127.0.0.1:5174',
    })

    expect(settings.url).toBe('http://127.0.0.1:5174/')
    expect(settings.command).toBe(
      'npm run dev -- --host 0.0.0.0 --port 5174 --strictPort',
    )
    expect(settings.reuseExistingServer).toBe(false)
  })

  it('trims custom command and URL environment values', () => {
    const settings = resolveWebServerSettings({
      PLAYWRIGHT_WEB_SERVER_COMMAND:
        ' npm run dev -- --host 0.0.0.0 --port 5174 --strictPort ',
      PLAYWRIGHT_WEB_SERVER_URL: ' http://127.0.0.1:5174 ',
    })

    expect(settings.url).toBe('http://127.0.0.1:5174/')
    expect(settings.command).toBe(
      'npm run dev -- --host 0.0.0.0 --port 5174 --strictPort',
    )
  })

  it('treats whitespace-only custom commands as unset', () => {
    const settings = resolveWebServerSettings({
      PLAYWRIGHT_WEB_SERVER_COMMAND: ' ',
      PLAYWRIGHT_WEB_SERVER_URL: ' http://localhost:5174 ',
    })

    expect(settings.url).toBe('http://localhost:5174/')
    expect(settings.command).toBe(
      'npm run dev -- --host localhost --port 5174 --strictPort',
    )
    expect(settings.reuseExistingServer).toBe(true)
  })

  it('reuses local servers for explicit false CI values', () => {
    expect(resolveWebServerSettings({ CI: 'false' }).reuseExistingServer).toBe(
      true,
    )
    expect(
      resolveWebServerSettings({ CI: ' false ' }).reuseExistingServer,
    ).toBe(true)
    expect(resolveWebServerSettings({ CI: '0' }).reuseExistingServer).toBe(true)
    expect(resolveWebServerSettings({ CI: ' 0 ' }).reuseExistingServer).toBe(
      true,
    )
  })

  it('does not reuse local servers in CI', () => {
    expect(resolveWebServerSettings({ CI: 'true' }).reuseExistingServer).toBe(
      false,
    )
    expect(resolveWebServerSettings({ CI: '1' }).reuseExistingServer).toBe(
      false,
    )
  })

  it('requires a custom URL when a custom command is set', () => {
    expect(() =>
      resolveWebServerSettings({
        PLAYWRIGHT_WEB_SERVER_COMMAND:
          'npm run dev -- --host 127.0.0.1 --port 5174 --strictPort',
      }),
    ).toThrow(
      'PLAYWRIGHT_WEB_SERVER_URL must be set when PLAYWRIGHT_WEB_SERVER_COMMAND is set.',
    )
  })

  it('preserves scheme-default ports for custom command URLs', () => {
    const settings = resolveWebServerSettings({
      PLAYWRIGHT_WEB_SERVER_COMMAND: 'npm run preview',
      PLAYWRIGHT_WEB_SERVER_URL: 'https://example.test/what-license',
    })

    expect(settings.url).toBe('https://example.test/what-license/')
    expect(settings.command).toBe('npm run preview')
    expect(settings.reuseExistingServer).toBe(false)
  })

  it('allows local runs to reuse external preview URLs', () => {
    const settings = resolveWebServerSettings({
      PLAYWRIGHT_WEB_SERVER_URL: 'https://example.test/what-license',
    })

    expect(settings.url).toBe('https://example.test/what-license/')
    expect(settings.command).toContain(
      'PLAYWRIGHT_WEB_SERVER_URL must point to a running server when PLAYWRIGHT_WEB_SERVER_COMMAND is unset: https://example.test/what-license/',
    )
    expect(settings.reuseExistingServer).toBe(true)
  })

  it('preserves custom URL subpaths for local previews', () => {
    const settings = resolveWebServerSettings({
      PLAYWRIGHT_WEB_SERVER_URL: 'http://127.0.0.1:5173/what-license',
    })

    expect(settings.url).toBe('http://127.0.0.1:5173/what-license/')
    expect(settings.command).toBe(
      'npm run dev -- --host 127.0.0.1 --port 5173 --strictPort',
    )
  })

  it('keeps trailing slashes on custom URL subpaths', () => {
    const settings = resolveWebServerSettings({
      PLAYWRIGHT_WEB_SERVER_URL: 'http://127.0.0.1:5173/what-license/',
    })

    expect(settings.url).toBe('http://127.0.0.1:5173/what-license/')
    expect(settings.command).toBe(
      'npm run dev -- --host 127.0.0.1 --port 5173 --strictPort',
    )
  })

  it('uses local IPv6 hosts for the default dev command', () => {
    const settings = resolveWebServerSettings({
      PLAYWRIGHT_WEB_SERVER_URL: 'http://[::1]:5174/what-license',
    })

    expect(settings.url).toBe('http://[::1]:5174/what-license/')
    expect(settings.command).toBe(
      'npm run dev -- --host ::1 --port 5174 --strictPort',
    )
  })

  it('requires a custom command for non-local URLs in CI', () => {
    expect(() =>
      resolveWebServerSettings({
        CI: 'true',
        PLAYWRIGHT_WEB_SERVER_URL: 'https://example.test:5173/what-license',
      }),
    ).toThrow(
      'PLAYWRIGHT_WEB_SERVER_COMMAND must be set when PLAYWRIGHT_WEB_SERVER_URL cannot be served by the default dev server: https://example.test:5173/what-license/.',
    )
    expect(() =>
      resolveWebServerSettings({
        CI: 'true',
        PLAYWRIGHT_WEB_SERVER_URL: 'https://example.test/what-license',
      }),
    ).toThrow(
      'PLAYWRIGHT_WEB_SERVER_COMMAND must be set when PLAYWRIGHT_WEB_SERVER_URL cannot be served by the default dev server: https://example.test/what-license/.',
    )
  })

  it('requires a custom command for non-http local URLs in CI', () => {
    expect(() =>
      resolveWebServerSettings({
        CI: 'true',
        PLAYWRIGHT_WEB_SERVER_URL: 'https://127.0.0.1:5173/what-license',
      }),
    ).toThrow(
      'PLAYWRIGHT_WEB_SERVER_COMMAND must be set when PLAYWRIGHT_WEB_SERVER_URL cannot be served by the default dev server: https://127.0.0.1:5173/what-license/.',
    )
  })

  it('allows all-interface hosts for the default dev command', () => {
    const ipv4Settings = resolveWebServerSettings({
      PLAYWRIGHT_WEB_SERVER_URL: 'http://0.0.0.0:5174/what-license',
    })
    const ipv6Settings = resolveWebServerSettings({
      PLAYWRIGHT_WEB_SERVER_URL: 'http://[::]:5175/what-license',
    })

    expect(ipv4Settings.url).toBe('http://127.0.0.1:5174/what-license/')
    expect(ipv4Settings.command).toBe(
      'npm run dev -- --host 0.0.0.0 --port 5174 --strictPort',
    )
    expect(ipv6Settings.url).toBe('http://[::1]:5175/what-license/')
    expect(ipv6Settings.command).toBe(
      'npm run dev -- --host :: --port 5175 --strictPort',
    )
  })
})
