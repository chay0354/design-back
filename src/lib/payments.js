import { randomUUID } from 'node:crypto'
import { HttpError } from './http.js'

/**
 * Payment gateway boundary. The site currently runs demo payments; a real
 * Israeli gateway (hosted payment page) plugs in here without touching the
 * order, coupon or voucher logic. Card numbers never reach this server.
 *
 * PAYMENT_PROVIDER=demo (default) approves every charge.
 */
export async function charge({ amount, description, customerEmail }) {
  const provider = (process.env.PAYMENT_PROVIDER || 'demo').toLowerCase()

  if (amount <= 0) {
    return { provider: 'none', reference: '' }
  }

  if (provider === 'demo') {
    return { provider: 'demo', reference: `demo-${randomUUID()}` }
  }

  throw new HttpError(
    501,
    `Payment provider "${provider}" is not connected yet`,
    { amount, description, customerEmail },
  )
}
