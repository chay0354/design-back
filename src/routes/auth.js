import { Router } from 'express'
import { getAdmin, unwrap } from '../lib/supabaseAdmin.js'
import { HttpError, requireString, route } from '../lib/http.js'

const router = Router()

function normalizeEmail(value) {
  return requireString(value, 'email', { max: 200 }).trim().toLowerCase()
}

async function ensureProfile(admin, userId, email) {
  const existing = unwrap(await admin.from('petite_profiles').select('id').eq('id', userId).maybeSingle())
  if (existing) return
  unwrap(
    await admin.from('petite_profiles').insert({
      id: userId,
      email,
      name: email.split('@')[0] || '',
    }),
  )
}

/**
 * Creates the account on the server and marks the email as confirmed.
 * Avoids Supabase's confirmation-email rate limit, which was blocking signups.
 */
router.post(
  '/signup',
  route(async (req, res) => {
    const email = normalizeEmail(req.body?.email)
    const password = requireString(req.body?.password, 'password', { max: 200 })
    if (password.length < 6) throw new HttpError(400, 'הסיסמה חייבת להכיל לפחות 6 תווים')

    const admin = getAdmin()
    const created = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    })

    if (!created.error) {
      const user = created.data?.user
      if (!user?.id) throw new HttpError(500, 'לא הצלחנו ליצור את החשבון')
      await ensureProfile(admin, user.id, email)
      res.status(201).json({ ok: true, userId: user.id })
      return
    }

    const message = (created.error.message || '').toLowerCase()
    const alreadyExists =
      message.includes('already') || message.includes('registered') || created.error.status === 422
    if (!alreadyExists) throw created.error

    // Account may already exist from a failed confirmation-email attempt — unlock it with the password they just typed.
    const listed = await admin.auth.admin.listUsers({ page: 1, perPage: 200 })
    if (listed.error) throw listed.error
    const existing = (listed.data?.users || []).find((user) => (user.email || '').toLowerCase() === email)
    if (!existing) throw new HttpError(409, 'כתובת האימייל כבר רשומה — נסי להתחבר')

    const updated = await admin.auth.admin.updateUserById(existing.id, {
      password,
      email_confirm: true,
    })
    if (updated.error) throw updated.error
    await ensureProfile(admin, existing.id, email)
    res.json({ ok: true, userId: existing.id, recovered: true })
  }),
)

/**
 * Confirms a just-created Auth user when the browser signup path was used
 * and confirmation mail never arrived.
 */
router.post(
  '/confirm-signup',
  route(async (req, res) => {
    const email = normalizeEmail(req.body?.email)
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

    await ensureProfile(admin, userId, email)
    res.json({ ok: true })
  }),
)

export default router
