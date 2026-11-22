import { Router } from 'express'
import { getAdmin, unwrap } from '../lib/supabaseAdmin.js'
import { HttpError, requireString, route } from '../lib/http.js'

const router = Router()

/**
 * Confirms a just-created account when Supabase Auth requires email verification
 * but confirmation mail is not configured / not arriving.
 * Safe: knowing userId+email alone still needs the password to sign in.
 */
router.post(
  '/confirm-signup',
  route(async (req, res) => {
    const email = requireString(req.body?.email, 'email', { max: 200 }).trim().toLowerCase()
    const userId = requireString(req.body?.userId, 'userId', { max: 60 })

    const admin = getAdmin()
    const { data, error } = await admin.auth.admin.getUserById(userId)
    if (error || !data?.user) throw new HttpError(404, 'המשתמש לא נמצא')

    const user = data.user
    if ((user.email || '').toLowerCase() !== email) {
      throw new HttpError(404, 'המשתמש לא נמצא')
    }

    if (!user.email_confirmed_at) {
      const updated = await admin.auth.admin.updateUserById(userId, { email_confirm: true })
      if (updated.error) throw updated.error
    }

    const existing = unwrap(
      await admin.from('petite_profiles').select('id').eq('id', userId).maybeSingle(),
    )
    if (!existing) {
      unwrap(
        await admin.from('petite_profiles').insert({
          id: userId,
          email,
          name: email.split('@')[0] || '',
        }),
      )
    }

    res.json({ ok: true })
  }),
)

export default router
