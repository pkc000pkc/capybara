import { ProxyAgent } from 'proxy-agent'
import { UserPreferencesStore } from '#core/user-preferences'
import { diagnosticLog } from './diagnostic-log.js'

let preferences = () => new UserPreferencesStore().read()
export function configureProxyPreferences(read: typeof preferences): void { preferences = read }
export const modelProxyAgent = new ProxyAgent({ getProxyForUrl: (target) => {
  const host = new URL(target).hostname
  if (['localhost', '127.0.0.1', '[::1]', '::1'].includes(host)) return ''
  const proxy = preferences().proxy
  diagnosticLog('http.route', { targetHost: host, route: proxy?.enabled ? 'proxy' : 'direct', proxyServer: proxy?.enabled ? proxy.url : null })
  return proxy?.enabled ? proxy.url : ''
} })
