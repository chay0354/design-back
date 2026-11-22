export class HttpError extends Error {
  constructor(status, message, details = undefined) {
    super(message)
    this.status = status
    this.details = details
  }
}

/** Wraps an async route so thrown errors reach the Express error handler. */
export function route(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next)
  }
}

export function requireString(value, field, { max = 500, optional = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (optional) return ''
    throw new HttpError(400, `Missing ${field}`)
  }
  if (typeof value !== 'string') throw new HttpError(400, `Invalid ${field}`)
  const trimmed = value.trim()
  if (!optional && !trimmed) throw new HttpError(400, `Missing ${field}`)
  if (trimmed.length > max) throw new HttpError(400, `${field} is too long`)
  return trimmed
}

export function optionalNumber(value, field, { min = -Infinity, max = Infinity } = {}) {
  if (value === undefined || value === null || value === '') return null
  const num = Number(value)
  if (!Number.isFinite(num) || num < min || num > max) {
    throw new HttpError(400, `Invalid ${field}`)
  }
  return num
}

export function isEmail(value) {
  return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())
}

/** Parses ?from=YYYY-MM-DD&to=YYYY-MM-DD into an inclusive [from, to) ISO range. */
export function parseDateRange(query, defaultDays = 30) {
  const now = new Date()
  const to = query.to ? new Date(`${query.to}T00:00:00.000Z`) : now
  if (query.to) to.setUTCDate(to.getUTCDate() + 1)
  const from = query.from
    ? new Date(`${query.from}T00:00:00.000Z`)
    : new Date(to.getTime() - defaultDays * 86400000)
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) {
    throw new HttpError(400, 'Invalid date range')
  }
  return { from, to }
}
