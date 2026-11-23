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
import roomRoutes from './routes/rooms.js'
import authRoutes from './routes/auth.js'
import { isAllowedOrigin } from './lib/origins.js'

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
const smallJson = express.json({ limit: '200kb' })
const photoJson = express.json({ limit: '4mb' })
app.use((req, res, next) => (req.path === '/api/rooms/visualize' ? photoJson : smallJson)(req, res, next))

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
app.use('/api/rooms', roomRoutes)
app.use('/api/auth', authRoutes)
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
