const SCRAPINGBEE_URL = 'https://app.scrapingbee.com/api/v1/'

export function isBlockedHtml(html) {
  if (!html || html.length < 8000) return true
  return /_____tmd_____|captchaRecaptcha|unusual traffic|哎哟喂,被挤爆啦/i.test(html)
}

export async function fetchHtmlViaScrapingBee(pageUrl) {
  const apiKey = process.env.SCRAPINGBEE_API_KEY
  if (!apiKey) return null

  const proxyUrl = new URL(SCRAPINGBEE_URL)
  proxyUrl.searchParams.set('api_key', apiKey)
  proxyUrl.searchParams.set('url', pageUrl)
  proxyUrl.searchParams.set('render_js', 'false')
  proxyUrl.searchParams.set('premium_proxy', 'true')
  proxyUrl.searchParams.set('country_code', 'us')

  try {
    const response = await fetch(proxyUrl, { redirect: 'follow' })
    if (!response.ok) return null
    const html = await response.text()
    return isBlockedHtml(html) ? null : html
  } catch {
    return null
  }
}
