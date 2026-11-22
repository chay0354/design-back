import cors from 'cors'
import express from 'express'
import { createClient } from '@supabase/supabase-js'
import {
  fetchImageBuffer,
  fetchOgImage,
  isValidHttpUrl,
  resolveProductLink,
} from './productImage.js'
import { HttpError } from './lib/http.js'
import checkoutRoutes from './routes/checkout.js'
import voucherRoutes, { shareRouter } from './routes/vouchers.js'
import trackingRoutes from './routes/tracking.js'
import adminRoutes from './routes/admin.js'
import cronRoutes from './routes/cron.js'

function getAllowedOrigins() {
  const origins = new Set([
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'https://petite-dreams.com',
    'https://www.petite-dreams.com',
    'https://design-front.vercel.app',
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
    if (hostname.endsWith('.vercel.app')) return true
    if (hostname === 'petite-dreams.com' || hostname.endsWith('.petite-dreams.com')) {
      return true
    }
  } catch {
    return false
  }

  return false
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
      if (!origin || isAllowedOrigin(origin)) {
        callback(null, origin || true)
        return
      }
      callback(null, false)
    },
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  }),
)
app.use(express.json({ limit: '200kb' }))

app.get('/', (_req, res) => {
  res.json({
    ok: true,
    service: 'design-back',
    endpoints: [
      '/api/health',
      '/api/product-image',
      '/api/image-proxy',
      '/api/checkout/*',
      '/api/vouchers/*',
      '/api/referrals/visit',
      '/api/events',
      '/api/admin/*',
    ],
  })
})

app.get('/api/resolve-product-link', async (req, res) => {
  const sourceUrl = req.query.url
  if (!isValidHttpUrl(sourceUrl)) {
    res.status(400).json({ error: 'Invalid or missing url' })
    return
  }

  try {
    const resolved = await resolveProductLink(sourceUrl.trim())
    if (!resolved) {
      res.status(422).json({ error: 'Could not resolve product link' })
      return
    }
    res.json({ ...resolved, sourceUrl: sourceUrl.trim() })
  } catch (err) {
    res.status(502).json({ error: String(err) })
  }
})

app.get('/api/product-image', async (req, res) => {
  const sourceUrl = req.query.url
  if (!isValidHttpUrl(sourceUrl)) {
    res.status(400).json({ error: 'Invalid or missing url' })
    return
  }

  try {
    const trimmedUrl = sourceUrl.trim()
    const resolved = await resolveProductLink(trimmedUrl)
    const imageUrl = await fetchOgImage(trimmedUrl)
    if (!imageUrl) {
      res.status(422).json({
        error: process.env.SCRAPINGBEE_API_KEY
          ? 'No product image found for this link'
          : 'AliExpress blocked automated fetch. Add SCRAPINGBEE_API_KEY on the backend, use a local backend override, or paste direct alicdn image URLs.',
        itemId: resolved?.itemId ?? null,
        productUrl: resolved?.productUrl ?? null,
      })
      return
    }
    res.json({
      imageUrl,
      sourceUrl: trimmedUrl,
      itemId: resolved?.itemId ?? null,
      productUrl: resolved?.productUrl ?? null,
    })
  } catch (err) {
    res.status(502).json({ error: String(err) })
  }
})

app.get('/api/image-proxy', async (req, res) => {
  const imageUrl = req.query.url
  if (!isValidHttpUrl(imageUrl)) {
    res.status(400).json({ error: 'Invalid or missing url' })
    return
  }

  try {
    const { buffer, contentType } = await fetchImageBuffer(imageUrl.trim())
    res.setHeader('Content-Type', contentType.split(';')[0])
    res.setHeader('Cache-Control', 'public, max-age=86400')
    res.send(buffer)
  } catch (err) {
    res.status(502).json({ error: String(err) })
  }
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

app.use('/api/checkout', checkoutRoutes)
app.use('/api/vouchers', voucherRoutes)
app.use('/api/g', shareRouter)
app.use('/api', trackingRoutes)
app.use('/api/admin', adminRoutes)
app.use('/api/cron', cronRoutes)

app.use((err, req, res, next) => {
  if (res.headersSent) {
    next(err)
    return
  }
  if (err instanceof HttpError) {
    const origin = req.headers.origin
    if (origin && isAllowedOrigin(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Vary', 'Origin')
    }
    res.status(err.status).json({ error: err.message, details: err.details })
    return
  }
  console.error(err)
  const origin = req.headers.origin
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
  }
  res.status(500).json({ error: String(err) })
})

export default app
