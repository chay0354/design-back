import { Router } from 'express'
import { requireUser } from '../lib/auth.js'
import { getAdmin, unwrap } from '../lib/supabaseAdmin.js'
import { HttpError, requireString, route } from '../lib/http.js'
import { isAllowedOrigin } from '../lib/origins.js'
import {
  copiedPackageRoom,
  fetchPackageImage,
  generateRoomVisualization,
  parseImageDataUrl,
  resolvePackageImageUrl,
} from '../lib/roomVisualizer.js'

const router = Router()

const VISUALIZATION_BUCKET = 'room-visualizations'
const SIGNED_URL_SECONDS = 60 * 60 * 24 * 7

function dailyVisualizationLimit() {
  const limit = Number.parseInt(process.env.VISUALIZE_DAILY_LIMIT || '', 10)
  return Number.isInteger(limit) && limit > 0 ? limit : 30
}

async function signedVisualizationUrl(db, path) {
  const { data, error } = await db.storage.from(VISUALIZATION_BUCKET).createSignedUrl(path, SIGNED_URL_SECONDS)
  if (error) throw error
  return data.signedUrl
}

/**
 * Dresses the purchased package onto a photo of the buyer's own room (Gemini image model).
 * Body: { packageId, packageImageUrl, roomKey?, image: data:image/jpeg;base64,... }
 */
router.post(
  '/visualize',
  requireUser,
  route(async (req, res) => {
    const db = getAdmin()
    const user = req.user
    const packageId = requireString(req.body?.packageId, 'packageId', { max: 120 })
    const roomKey = requireString(req.body?.roomKey, 'roomKey', { max: 120, optional: true })
    const roomImage = parseImageDataUrl(req.body?.image)

    if (!user.isAdmin) {
      const purchases = unwrap(await db.from('order_items').select('id').eq('user_id', user.id).limit(1))
      if (purchases.length === 0) throw new HttpError(403, 'ההדמיה זמינה לאחר רכישת חבילת עיצוב')

      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
      const { count, error } = await db
        .from('room_visualizations')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', user.id)
        .neq('status', 'failed')
        .gte('created_at', since)
      if (error) throw error
      if ((count ?? 0) >= dailyVisualizationLimit()) {
        throw new HttpError(429, 'הגעתם למספר ההדמיות היומי. אפשר לנסות שוב מחר')
      }
    }

    const origin = req.headers.origin
    const siteOrigin =
      origin && isAllowedOrigin(origin) ? origin : (process.env.FRONTEND_URL || 'https://petite-dreams.com').replace(/\/$/, '')
    const packageImageUrl = resolvePackageImageUrl(req.body?.packageImageUrl, { siteOrigin, isAllowedOrigin })

    const record = unwrap(
      await db
        .from('room_visualizations')
        .insert({ user_id: user.id, package_id: packageId, room_key: roomKey })
        .select('id')
        .single(),
    )

    try {
      const packageImage = await fetchPackageImage(packageImageUrl)
      const started = Date.now()
      let result = await generateRoomVisualization({ packageImage, roomImage, timeoutMs: 50000 })
      let verdict = await copiedPackageRoom({ output: result, packageImage, roomImage }).catch((err) => {
        console.error('visualization compare failed', err?.message)
        return { copied: false }
      })
      if (verdict.copied) {
        console.warn('visualization copied the package room', verdict)
        const retryBudget = 105000 - (Date.now() - started)
        if (retryBudget > 20000) {
          result = await generateRoomVisualization({
            packageImage,
            roomImage,
            retry: true,
            timeoutMs: Math.min(50000, retryBudget),
          })
          verdict = await copiedPackageRoom({ output: result, packageImage, roomImage }).catch(() => ({ copied: false }))
        }
      }
      if (verdict.copied) {
        throw new HttpError(502, 'ההדמיה חזרה על תמונת החבילה במקום החדר. נסו שוב')
      }
      const extension = result.mimeType === 'image/jpeg' ? 'jpg' : result.mimeType === 'image/webp' ? 'webp' : 'png'
      const path = `${user.id}/${record.id}.${extension}`
      const { error: uploadError } = await db.storage
        .from(VISUALIZATION_BUCKET)
        .upload(path, result.buffer, { contentType: result.mimeType, upsert: true })
      if (uploadError) throw uploadError

      unwrap(
        await db
          .from('room_visualizations')
          .update({ status: 'done', image_path: path, model: result.model })
          .eq('id', record.id),
      )
      res.json({ id: record.id, imageUrl: await signedVisualizationUrl(db, path) })
    } catch (err) {
      await db
        .from('room_visualizations')
        .update({ status: 'failed', error: String(err?.message || err).slice(0, 500) })
        .eq('id', record.id)
      throw err
    }
  }),
)

/** Latest finished visualization for this package (and room, when given). */
router.get(
  '/visualizations/latest',
  requireUser,
  route(async (req, res) => {
    const db = getAdmin()
    const packageId = requireString(req.query.packageId, 'packageId', { max: 120 })
    const roomKey = requireString(req.query.roomKey, 'roomKey', { max: 120, optional: true })
    const since = requireString(req.query.since, 'since', { max: 40, optional: true })
    let query = db
      .from('room_visualizations')
      .select('id, image_path, created_at')
      .eq('user_id', req.user.id)
      .eq('package_id', packageId)
      .eq('status', 'done')
      .order('created_at', { ascending: false })
      .limit(1)
    if (roomKey) query = query.eq('room_key', roomKey)
    if (since) query = query.gt('created_at', since)
    const [latest] = unwrap(await query)
    if (!latest?.image_path) {
      res.json({ visualization: null })
      return
    }
    res.json({
      visualization: {
        id: latest.id,
        createdAt: latest.created_at,
        imageUrl: await signedVisualizationUrl(db, latest.image_path),
      },
    })
  }),
)

function cleanAllocationChild(raw, index) {
  const name = String(raw?.name || '').trim()
  if (!name) throw new HttpError(400, `חסר שם לילד מספר ${index + 1}`)
  const age = Number.parseInt(raw?.age, 10)
  if (!Number.isInteger(age) || age < 0 || age > 18) throw new HttpError(400, `גיל לא תקין עבור ${name}`)
  const gender = raw?.gender === 'girl' || raw?.gender === 'boy' ? raw.gender : ''
  return { name: name.slice(0, 80), age, gender }
}

/**
 * Updates ages / children / room grouping for the buyer's active rooms
 * before they choose a new design package.
 */
router.post(
  '/allocation',
  requireUser,
  route(async (req, res) => {
    const db = getAdmin()
    const userId = req.user.id
    const rooms = Array.isArray(req.body?.rooms) ? req.body.rooms : null
    if (!rooms || rooms.length === 0) throw new HttpError(400, 'לא התקבלה חלוקת חדרים')

    const profile = unwrap(await db.from('petite_profiles').select('children').eq('id', userId).single())
    const children = Array.isArray(profile.children) ? [...profile.children] : []
    const now = new Date().toISOString()

    for (const room of rooms) {
      const roomChildren = (Array.isArray(room.children) ? room.children : []).map(cleanAllocationChild)
      if (roomChildren.length === 0) continue

      const roomId = room.roomId ? String(room.roomId) : null
      const orderItemId = room.orderItemId ? String(room.orderItemId) : null
      let target = null
      if (roomId) target = children.find((child) => child.roomId === roomId && !child.archivedAt)
      if (!target && orderItemId) {
        target = children.find((child) => child.orderItemId === orderItemId && !child.archivedAt)
      }
      if (!target) continue

      target.roomChildren = roomChildren
      target.name = roomChildren.map((child) => child.name).join(' ו')
      target.age = roomChildren[0].age
      target.gender = roomChildren[0].gender || target.gender
    }

    unwrap(await db.from('petite_profiles').update({ children, updated_at: now }).eq('id', userId))
    res.json({ ok: true })
  }),
)

/**
 * Brings an archived package back as the room's current package.
 * The package that was current moves to the archive, so nothing is ever lost.
 */
router.post(
  '/:roomId/restore',
  requireUser,
  route(async (req, res) => {
    const db = getAdmin()
    const userId = req.user.id
    const roomId = req.params.roomId
    const orderItemId = requireString(req.body?.orderItemId, 'orderItemId', { max: 60 })

    const restored = unwrap(
      await db
        .from('order_items')
        .select('id, room_id, archived_at')
        .eq('id', orderItemId)
        .eq('user_id', userId)
        .maybeSingle(),
    )
    if (!restored || restored.room_id !== roomId) throw new HttpError(404, 'Package not found for this room')
    if (!restored.archived_at) {
      res.json({ ok: true, unchanged: true })
      return
    }

    const now = new Date().toISOString()
    unwrap(
      await db
        .from('order_items')
        .update({ archived_at: now, replaced_by_item_id: restored.id })
        .eq('room_id', roomId)
        .eq('user_id', userId)
        .is('archived_at', null),
    )
    unwrap(
      await db.from('order_items').update({ archived_at: null, replaced_by_item_id: null }).eq('id', restored.id),
    )

    const profile = unwrap(await db.from('petite_profiles').select('children').eq('id', userId).single())
    const children = (Array.isArray(profile.children) ? profile.children : []).map((child) => {
      if (child.roomId !== roomId) return child
      if (child.orderItemId === restored.id) {
        const { archivedAt: _archivedAt, ...active } = child
        return active
      }
      return child.archivedAt ? child : { ...child, archivedAt: now }
    })
    unwrap(await db.from('petite_profiles').update({ children, updated_at: now }).eq('id', userId))

    res.json({ ok: true })
  }),
)

export default router
