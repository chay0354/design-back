import { HttpError } from './http.js'
import { layoutSimilarity } from './imageSimilarity.js'
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

const EDIT_ROOM_REMINDER =
  'ערוך את צילום החדר הקיים של הלקוח: אותם קירות, אותו חלון, אותם ארונות, אותה רצפה ואותה זווית צילום. ' +
  'קח מהדמיית החבילה רק את הריהוט המשלים, הצבעים, התמונות, המדפים, הטקסטיל והדקורציה. ' +
  'אסור להחזיר את הדמיית החבילה עצמה או חדר עם המבנה והזווית שלה.\n' +
  "Edit the client's room photo. Keep its walls, window, built-ins, floor and camera angle. " +
  'Do not return the package rendering or a room with its layout.'

const RETRY_REMINDER =
  'הניסיון הקודם החזיר את חדר החבילה במקום את החדר של הלקוח. ' +
  'הפעם התוצאה חייבת להיות צילום החדר של הלקוח, מזוהה לפי החלון, הקירות והזווית שלו, עם פריטי החבילה בתוכו.\n' +
  "The previous attempt returned the package room. This time the output must be the client's own room, " +
  'recognizable by its window, walls and angle, dressed with the package items.'

/** Sends the room photo + package image to Gemini and returns the generated image. */
export async function generateRoomVisualization({ packageImage, roomImage, retry = false, timeoutMs = 80000 }) {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) throw new HttpError(503, 'שירות ההדמיה עדיין לא הוגדר')
  const model = process.env.GEMINI_IMAGE_MODEL || DEFAULT_IMAGE_MODEL

  const res = await fetch(`${GEMINI_URL}/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({
      contents: [
        {
          role: 'user',
          parts: [
            { text: ROOM_DRESSING_PROMPT },
            { text: 'תמונה 1 – הדמיית חבילת העיצוב של PETITE DREAMS. מקור לפריטים ולצבעים בלבד, לא הבסיס לעריכה.' },
            { inlineData: packageImage },
            { text: 'תמונה 2 – צילום החדר הקיים של הלקוח. זה הבסיס היחיד לעריכה.' },
            { inlineData: roomImage },
            { text: EDIT_ROOM_REMINDER },
            ...(retry ? [{ text: RETRY_REMINDER }] : []),
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

/** True when the output keeps the package rendering's layout instead of the client's room. */
export async function copiedPackageRoom({ output, packageImage, roomImage }) {
  const outputBuffer = output.buffer
  const [toPackage, toRoom] = await Promise.all([
    layoutSimilarity(outputBuffer, Buffer.from(packageImage.data, 'base64')),
    layoutSimilarity(outputBuffer, Buffer.from(roomImage.data, 'base64')),
  ])
  return { copied: toPackage >= 0.55 && toPackage > toRoom + 0.12, toPackage, toRoom }
}
