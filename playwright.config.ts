import { defineConfig, devices } from '@playwright/test'

const defaultWebServerUrl = 'http://127.0.0.1:5173'
const defaultWebServerEndpoint = new URL(defaultWebServerUrl)

interface WebServerSettings {
  command: string
  reuseExistingServer: boolean
  url: string
}

export function isCiEnvironment(value: string | undefined): boolean {
  if (value === undefined || value === '') return false
  const normalizedValue = value.trim().toLowerCase()
  if (!normalizedValue) return false
  return normalizedValue !== '0' && normalizedValue !== 'false'
}

function normalizeUrlHostname(hostname: string): string {
  return hostname.replace(/^\[(.*)\]$/, '$1')
}

function isDefaultDevServerHost(hostname: string): boolean {
  const normalizedHostname = normalizeUrlHostname(hostname)
  return (
    normalizedHostname === 'localhost' ||
    normalizedHostname === '127.0.0.1' ||
    normalizedHostname === '::1' ||
    normalizedHostname === '0.0.0.0' ||
    normalizedHostname === '::'
  )
}

function isDefaultDevServerProtocol(protocol: string): boolean {
  return protocol === defaultWebServerEndpoint.protocol
}

function defaultDevServerCommandHost(hostname: string): string {
  if (isDefaultDevServerHost(hostname)) return normalizeUrlHostname(hostname)
  return normalizeUrlHostname(defaultWebServerEndpoint.hostname)
}

function externalPreviewFallbackCommand(url: string): string {
  return (
    'node -e ' +
    JSON.stringify(
      'console.error("PLAYWRIGHT_WEB_SERVER_URL must point to a running server when PLAYWRIGHT_WEB_SERVER_COMMAND is unset: ' +
        url +
        '"); process.exit(1)',
    )
  )
}

function defaultDevServerUrlHostname(hostname: string): string | undefined {
  if (hostname === '0.0.0.0') return '127.0.0.1'
  if (hostname === '::') return '[::1]'
  return undefined
}

export function resolveWebServerSettings(
  env: Record<string, string | undefined> = process.env,
): WebServerSettings {
  const customWebServerCommand = env.PLAYWRIGHT_WEB_SERVER_COMMAND?.trim() || ''
  const customWebServerUrl = env.PLAYWRIGHT_WEB_SERVER_URL?.trim() || ''
  const hasCustomWebServerCommand = Boolean(customWebServerCommand)
  const hasCustomWebServerUrl = Boolean(customWebServerUrl)
  if (hasCustomWebServerCommand && !hasCustomWebServerUrl) {
    throw new Error(
      'PLAYWRIGHT_WEB_SERVER_URL must be set when PLAYWRIGHT_WEB_SERVER_COMMAND is set.',
    )
  }
  const webServerEndpoint = new URL(customWebServerUrl || defaultWebServerUrl)
  if (
    !webServerEndpoint.port &&
    !hasCustomWebServerCommand &&
    isDefaultDevServerProtocol(webServerEndpoint.protocol) &&
    isDefaultDevServerHost(webServerEndpoint.hostname)
  ) {
    webServerEndpoint.port = defaultWebServerEndpoint.port
  }
  if (
    webServerEndpoint.pathname !== '/' &&
    !webServerEndpoint.pathname.endsWith('/')
  ) {
    webServerEndpoint.pathname += '/'
  }
  const webServerHost = normalizeUrlHostname(webServerEndpoint.hostname)
  if (
    !hasCustomWebServerCommand &&
    isCiEnvironment(env.CI) &&
    (!isDefaultDevServerProtocol(webServerEndpoint.protocol) ||
      !isDefaultDevServerHost(webServerHost))
  ) {
    throw new Error(
      'PLAYWRIGHT_WEB_SERVER_COMMAND must be set when PLAYWRIGHT_WEB_SERVER_URL cannot be served by the default dev server: ' +
        webServerEndpoint.href +
        '.',
    )
  }
  if (!hasCustomWebServerCommand) {
    const urlHostname = defaultDevServerUrlHostname(webServerHost)
    if (urlHostname) webServerEndpoint.hostname = urlHostname
  }
  const webServerUrl = webServerEndpoint.href
  const webServerPort = webServerEndpoint.port || defaultWebServerEndpoint.port
  const webServerCommandHost = defaultDevServerCommandHost(webServerHost)
  const canUseDefaultDevServer =
    isDefaultDevServerProtocol(webServerEndpoint.protocol) &&
    isDefaultDevServerHost(webServerHost)
  const command =
    customWebServerCommand ||
    (canUseDefaultDevServer
      ? 'npm run dev -- --host ' +
        webServerCommandHost +
        ' --port ' +
        webServerPort +
        ' --strictPort'
      : externalPreviewFallbackCommand(webServerUrl))

  return {
    command,
    url: webServerUrl,
    reuseExistingServer: !isCiEnvironment(env.CI) && !hasCustomWebServerCommand,
  }
}

const isCi = isCiEnvironment(process.env.CI)
const webServerSettings = resolveWebServerSettings()

export default defineConfig({
  testDir: 'e2e',
  retries: isCi ? 1 : 0,
  forbidOnly: isCi,
  webServer: webServerSettings,
  use: {
    baseURL: webServerSettings.url,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
})
