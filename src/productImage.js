const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const OG_IMAGE_RE = /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i
const OG_IMAGE_RE_ALT = /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i
const ALICDN_IMAGE_RE = /https?:\/\/[^"'\s]+\.alicdn\.com\/[^"'\s]+\.(?:jpg|jpeg|png|webp)/i
const ITEM_ID_RE = /\/item\/(\d+)\.html/i

function normalizeImageUrl(image) {
  let normalized = image.trim()
  if (normalized.startsWith('//')) {
    normalized = `https:${normalized}`
  }
  return normalized
}

function extractImageFromHtml(html) {
  for (const pattern of [OG_IMAGE_RE, OG_IMAGE_RE_ALT]) {
    const match = html.match(pattern)
    if (match?.[1]) {
      return normalizeImageUrl(match[1])
    }
  }

  const alicdnMatch = html.match(ALICDN_IMAGE_RE)
  if (alicdnMatch?.[0]) {
    return normalizeImageUrl(alicdnMatch[0])
  }

  return null
}

async function resolvePageUrl(pageUrl) {
  let currentUrl = pageUrl.trim()

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await fetch(currentUrl, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7',
      },
      redirect: 'manual',
    })

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (!location) break
      currentUrl = new URL(location, currentUrl).toString()
      continue
    }

    if (!response.ok) {
      throw new Error(`Page fetch failed (${response.status})`)
    }

    const html = await response.text()
    return { html, finalUrl: currentUrl }
  }

  throw new Error('Too many redirects while resolving product link')
}

export function isValidHttpUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return false

  try {
    const parsed = new URL(value.trim())
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

export async function fetchOgImage(pageUrl) {
  const { html, finalUrl } = await resolvePageUrl(pageUrl)
  const image = extractImageFromHtml(html)
  if (image) {
    return image
  }

  const itemMatch = finalUrl.match(ITEM_ID_RE)
  if (itemMatch?.[1]) {
    const canonicalUrl = `https://www.aliexpress.com/item/${itemMatch[1]}.html`
    if (canonicalUrl !== finalUrl) {
      const retry = await resolvePageUrl(canonicalUrl)
      return extractImageFromHtml(retry.html)
    }
  }

  return null
}

export async function fetchImageBuffer(imageUrl) {
  const referer = imageUrl.includes('alicdn.com')
    ? 'https://www.aliexpress.com/'
    : new URL(imageUrl).origin

  const response = await fetch(imageUrl, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'image/*,*/*;q=0.8',
      Referer: referer,
    },
    redirect: 'follow',
  })

  if (!response.ok) {
    throw new Error(`Image fetch failed (${response.status})`)
  }

  const contentType = response.headers.get('content-type') || 'image/jpeg'
  const buffer = Buffer.from(await response.arrayBuffer())

  return { buffer, contentType }
}
