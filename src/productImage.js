const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const OG_IMAGE_RE = /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i
const OG_IMAGE_RE_ALT = /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i
const IMAGE_PATH_LIST_RE = /"imagePathList"\s*:\s*\[\s*"([^"]+)"/i
const SUMM_IMAGE_PATH_RE = /"summImagePath"\s*:\s*"([^"]+)"/i
const ALICDN_IMAGE_RE = /https?:\/\/[^"'\s]+\.alicdn\.com\/[^"'\s]+\.(?:jpg|jpeg|png|webp)/i
const ITEM_ID_RE = /\/item\/(\d+)\.html/i

const FETCH_HEADERS = {
  'User-Agent': USER_AGENT,
  Accept: 'text/html,application/xhtml+xml,application/json',
  'Accept-Language': 'he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7',
}

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

  const listMatch = html.match(IMAGE_PATH_LIST_RE)
  if (listMatch?.[1]) {
    return normalizeImageUrl(listMatch[1])
  }

  const summMatch = html.match(SUMM_IMAGE_PATH_RE)
  if (summMatch?.[1]) {
    return normalizeImageUrl(summMatch[1])
  }

  const alicdnMatch = html.match(ALICDN_IMAGE_RE)
  if (alicdnMatch?.[0]) {
    return normalizeImageUrl(alicdnMatch[0])
  }

  return null
}

function extractItemId(...urls) {
  for (const url of urls) {
    const match = url?.match(ITEM_ID_RE)
    if (match?.[1]) {
      return match[1]
    }
  }
  return null
}

async function fetchPageHtml(pageUrl) {
  const response = await fetch(pageUrl.trim(), {
    headers: FETCH_HEADERS,
    redirect: 'follow',
  })

  if (!response.ok) {
    throw new Error(`Page fetch failed (${response.status})`)
  }

  return {
    html: await response.text(),
    finalUrl: response.url,
  }
}

async function resolveItemIdFromRedirect(pageUrl) {
  const response = await fetch(pageUrl.trim(), {
    headers: FETCH_HEADERS,
    redirect: 'manual',
  })

  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location')
    if (location) {
      return extractItemId(new URL(location, pageUrl).toString())
    }
  }

  return null
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
  const trimmedUrl = pageUrl.trim()
  let firstPage = null

  try {
    firstPage = await fetchPageHtml(trimmedUrl)
    const image = extractImageFromHtml(firstPage.html)
    if (image) {
      return image
    }
  } catch {
    // Fall back to resolving the item id from short-link redirects.
  }

  const itemId =
    extractItemId(firstPage?.finalUrl, trimmedUrl) ||
    (await resolveItemIdFromRedirect(trimmedUrl))

  if (!itemId) {
    return null
  }

  const candidates = [
    firstPage?.finalUrl,
    trimmedUrl,
    `https://he.aliexpress.com/item/${itemId}.html`,
    `https://www.aliexpress.com/item/${itemId}.html`,
    `https://m.aliexpress.com/item/${itemId}.html`,
  ].filter(Boolean)

  const seen = new Set()

  for (const candidate of candidates) {
    if (seen.has(candidate)) continue
    seen.add(candidate)

    try {
      const page =
        firstPage && candidate === firstPage.finalUrl ? firstPage : await fetchPageHtml(candidate)
      const image = extractImageFromHtml(page.html)
      if (image) {
        return image
      }
    } catch {
      // Try the next AliExpress URL variant.
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
