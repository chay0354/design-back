import { randomInt } from 'node:crypto'

// No 0/O/1/I/L so codes read cleanly from a printed voucher.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

export function randomCode(length) {
  let out = ''
  for (let i = 0; i < length; i += 1) out += ALPHABET[randomInt(ALPHABET.length)]
  return out
}

/** e.g. PD-7KQ4M9XA — long enough that codes cannot be guessed. */
export function newVoucherCode() {
  return `PD-${randomCode(8)}`
}

export function normalizeCode(code) {
  return String(code || '').trim().toUpperCase().replace(/\s+/g, '')
}

export function slugify(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}
