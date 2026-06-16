import cors from 'cors'
import express from 'express'
import { createClient } from '@supabase/supabase-js'

function getAllowedOrigins() {
  const origins = new Set([
    'http://localhost:5173',
    'http://127.0.0.1:5173',
  ])

  if (process.env.FRONTEND_URL) {
    origins.add(process.env.FRONTEND_URL.replace(/\/$/, ''))
  }

  return origins
}

function isAllowedOrigin(origin) {
  if (!origin) return true

  const allowed = getAllowedOrigins()
  if (allowed.has(origin)) return true

  try {
    const { hostname } = new URL(origin)
    return hostname.endsWith('.vercel.app')
  } catch {
    return false
  }
}

function getSupabase() {
  const supabaseUrl = process.env.SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_PUBLISHABLE_KEY

  if (!supabaseUrl || !supabaseKey) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_PUBLISHABLE_KEY')
  }

  return createClient(supabaseUrl, supabaseKey)
}

const app = express()

app.use(
  cors({
    origin(origin, callback) {
      callback(null, isAllowedOrigin(origin))
    },
  }),
)
app.use(express.json())

app.get('/', (_req, res) => {
  res.json({ ok: true, service: 'design-back', endpoints: ['/api/health'] })
})

app.get('/api/health', async (_req, res) => {
  try {
    const supabase = getSupabase()
    const { error } = await supabase.auth.getSession()
    res.json({
      ok: !error,
      supabase: error ? `error: ${error.message}` : 'connected',
    })
  } catch (err) {
    res.status(500).json({ ok: false, supabase: String(err) })
  }
})

export default app
