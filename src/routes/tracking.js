import { Router } from 'express'
import { optionalUser } from '../lib/auth.js'
import { getAdmin, unwrap } from '../lib/supabaseAdmin.js'
import { route } from '../lib/http.js'

const router = Router()
const EVENTS = new Set(['start', 'step', 'complete', 'cart'])
const isId = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{8,100}$/.test(value)

/** Records a landing from an influencer referral link (?ref=slug). */
router.post(
  '/referrals/visit',
  route(async (req, res) => {
    const slug = String(req.body?.ref || '').trim().toLowerCase()
    const visitorId = req.body?.visitorId
    if (!slug || !isId(visitorId)) {
      res.json({ tracked: false })
      return
    }
    const influencer = unwrap(
      await getAdmin().from('influencers').select('id, active').eq('referral_slug', slug).maybeSingle(),
    )
    if (!influencer?.active) {
      res.json({ tracked: false })
      return
    }
    unwrap(
      await getAdmin().from('referral_visits').insert({
        influencer_id: influencer.id,
        visitor_id: visitorId,
        landing_path: String(req.body?.path || '').slice(0, 300),
      }),
    )
    res.json({ tracked: true })
  }),
)

/** Questionnaire funnel events and the final answers (for the admin dashboard). */
router.post(
  '/events',
  optionalUser,
  route(async (req, res) => {
    const { sessionId, event, stepKind, stepIndex, rooms } = req.body || {}
    if (!isId(sessionId) || !EVENTS.has(event)) {
      res.status(400).json({ error: 'Invalid event' })
      return
    }
    const db = getAdmin()
    unwrap(
      await db.from('questionnaire_events').insert({
        session_id: sessionId,
        user_id: req.user?.id ?? null,
        event,
        step_kind: typeof stepKind === 'string' ? stepKind.slice(0, 40) : '',
        step_index: Number.isInteger(stepIndex) ? stepIndex : null,
      }),
    )

    if (event === 'complete' && Array.isArray(rooms)) {
      const cleanRooms = rooms.slice(0, 10).map((room) => ({
        theme: String(room?.theme || '').slice(0, 120),
        colorPreference: String(room?.colorPreference || '').slice(0, 120),
        designGender: String(room?.designGender || '').slice(0, 20),
        ageGroup: String(room?.ageGroup || '').slice(0, 10),
        ageTrack: room?.ageTrack === 'cross-age' ? 'cross-age' : 'child',
        children: (Array.isArray(room?.children) ? room.children : []).slice(0, 6).map((child) => ({
          age: Number.isFinite(Number(child?.age)) ? Number(child.age) : null,
          gender: ['boy', 'girl'].includes(child?.gender) ? child.gender : '',
        })),
      }))
      unwrap(
        await db
          .from('questionnaire_submissions')
          .upsert({ session_id: sessionId, user_id: req.user?.id ?? null, rooms: cleanRooms }, { onConflict: 'session_id' }),
      )
    }
    res.json({ ok: true })
  }),
)

export default router
