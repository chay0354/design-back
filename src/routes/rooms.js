import { Router } from 'express'
import { requireUser } from '../lib/auth.js'
import { getAdmin, unwrap } from '../lib/supabaseAdmin.js'
import { HttpError, requireString, route } from '../lib/http.js'

const router = Router()

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
