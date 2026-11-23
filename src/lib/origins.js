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

export function isAllowedOrigin(origin) {
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
