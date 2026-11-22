import { getAdmin } from './supabaseAdmin.js'
import { HttpError } from './http.js'

async function resolveUser(req) {
  const header = req.headers.authorization || ''
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
  if (!token) return null

  const { data, error } = await getAdmin().auth.getUser(token)
  if (error || !data?.user) return null

  const { data: profile } = await getAdmin()
    .from('petite_profiles')
    .select('id, email, name, is_admin')
    .eq('id', data.user.id)
    .maybeSingle()

  return {
    id: data.user.id,
    email: (data.user.email || profile?.email || '').toLowerCase(),
    name: profile?.name || '',
    isAdmin: profile?.is_admin === true,
  }
}

/** Attaches req.user when a valid Supabase access token is sent; never rejects. */
export function optionalUser(req, _res, next) {
  resolveUser(req)
    .then((user) => {
      req.user = user
      next()
    })
    .catch(next)
}

export function requireUser(req, _res, next) {
  resolveUser(req)
    .then((user) => {
      if (!user) throw new HttpError(401, 'Not signed in')
      req.user = user
      next()
    })
    .catch(next)
}

export function requireAdmin(req, _res, next) {
  resolveUser(req)
    .then((user) => {
      if (!user) throw new HttpError(401, 'Not signed in')
      if (!user.isAdmin) throw new HttpError(403, 'Admins only')
      req.user = user
      next()
    })
    .catch(next)
}
