import { HttpError } from './http.js'
import { ROOM_DRESSING_PROMPT } from './roomDressingPrompt.js'

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models'
const MAX_PACKAGE_IMAGE_BYTES = 15 * 1024 * 1024

export const DEFAULT_IMAGE_MODEL = 'gemini-3-pro-image'

/** Splits a `data:image/...;base64,` URL into mime type and raw base64. */
export function parseImageDataUrl(value) {
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(value || ''))
  if (!match) throw new HttpError(400, 'תמונת החדר לא תקינה')
  return { mimeType: match[1], data: match[2] }
}

/**
 * Package images are either bundled with the site (`/assets/...`) or stored in Supabase.
 * Only those hosts are fetched, so the endpoint can't be used to pull arbitrary URLs.
 */
export function resolvePackageImageUrl(raw, { siteOrigin, isAllowedOrigin }) {
  const value = String(raw || '').trim()
  if (!value) throw new HttpError(400, 'לחבילה הזו אין תמונת הדמיה')
  if (value.startsWith('/') && !value.startsWith('//')) {
    if (!siteOrigin) throw new HttpError(400, 'Missing site origin')
    return new URL(value, siteOrigin).toString()
  }
  let url
  try {
    url = new URL(value)
  } catch {
    throw new HttpError(400, 'כתובת תמונת החבילה לא תקינה')
  }
  const supabaseHost = process.env.SUPABASE_URL ? new URL(process.env.SUPABASE_URL).host : ''
  const packageStorage =
    url.protocol === 'https:' &&
    (url.host === supabaseHost || url.host.endsWith('.supabase.co')) &&
    url.pathname.startsWith('/storage/v1/object/public/package-images/')
  const siteImage = (url.protocol === 'https:' || url.protocol === 'http:') && isAllowedOrigin(url.origin)
  if (!packageStorage && !siteImage) throw new HttpError(400, 'תמונת החבילה ממקור לא מורשה')
  return url.toString()
}

export async function fetchPackageImage(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) })
  if (!res.ok) throw new HttpError(502, `לא הצלחנו לטעון את תמונת החבילה (${res.status})`)
  const mimeType = (res.headers.get('content-type') || '').split(';')[0].trim()
  if (!/^image\/(jpeg|png|webp)$/.test(mimeType)) throw new HttpError(502, 'תמונת החבילה בפורמט לא נתמך')
  const buffer = Buffer.from(await res.arrayBuffer())
  if (buffer.length > MAX_PACKAGE_IMAGE_BYTES) throw new HttpError(502, 'תמונת החבילה גדולה מדי')
  return { mimeType, data: buffer.toString('base64') }
}

/** Sends the package image + room photo to Gemini and returns the generated image. */
export async function generateRoomVisualization({ packageImage, roomImage }) {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) throw new HttpError(503, 'שירות ההדמיה עדיין לא הוגדר')
  const model = process.env.GEMINI_IMAGE_MODEL || DEFAULT_IMAGE_MODEL

  const res = await fetch(`${GEMINI_URL}/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    signal: AbortSignal.timeout(55000),
    body: JSON.stringify({
      contents: [
        {
          role: 'user',
          parts: [
            { text: ROOM_DRESSING_PROMPT },
            { text: 'תמונה 1 – הדמיית חבילת העיצוב של PETITE DREAMS.' },
            { inlineData: packageImage },
            { text: 'תמונה 2 – צילום החדר הקיים של הלקוח.' },
            { inlineData: roomImage },
          ],
        },
      ],
      generationConfig: { responseModalities: ['IMAGE'] },
    }),
  }).catch((err) => {
    if (err?.name === 'TimeoutError') throw new HttpError(504, 'ההדמיה לקחה יותר מדי זמן, נסו שוב')
    throw err
  })

  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    console.error('Gemini visualization failed', res.status, json?.error?.message)
    if (res.status === 429) throw new HttpError(503, 'שירות ההדמיה עמוס כרגע, נסו שוב בעוד כמה דקות')
    throw new HttpError(502, 'לא הצלחנו ליצור את ההדמיה, נסו שוב')
  }

  const parts = json.candidates?.[0]?.content?.parts || []
  const image = parts.find((part) => part.inlineData?.data)?.inlineData
  if (!image) {
    console.error('Gemini returned no image', json.candidates?.[0]?.finishReason, json.promptFeedback)
    throw new HttpError(502, 'לא התקבלה הדמיה מהתמונה הזו. נסו תמונה אחרת של החדר')
  }
  return { model, mimeType: image.mimeType || 'image/png', buffer: Buffer.from(image.data, 'base64') }
}
