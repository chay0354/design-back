const USER_AGENT = 'Mozilla/5.0 (compatible; PetiteDreams/1.0)'

const OG_IMAGE_RE = /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i
const OG_IMAGE_RE_ALT = /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i

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
  const response = await fetch(pageUrl, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'he-IL,he;q=0.9,en;q=0.8',
    },
    redirect: 'follow',
  })

  if (!response.ok) {
    throw new Error(`Page fetch failed (${response.status})`)
  }

  const html = await response.text()

  for (const pattern of [OG_IMAGE_RE, OG_IMAGE_RE_ALT]) {
    const match = html.match(pattern)
    if (match?.[1]) {
      let image = match[1].trim()
      if (image.startsWith('//')) {
        image = `https:${image}`
      }
      return image
    }
  }

  return null
}

export async function fetchImageBuffer(imageUrl) {
  const response = await fetch(imageUrl, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'image/*,*/*;q=0.8',
      Referer: new URL(imageUrl).origin,
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
