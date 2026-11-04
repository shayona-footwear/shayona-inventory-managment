import { betterAuth } from 'better-auth'
import { pool } from '@/lib/db'

if (!process.env.BETTER_AUTH_SECRET) {
  throw new Error('BETTER_AUTH_SECRET environment variable is required')
}

// Google OAuth only accepts redirect URIs registered in Google Cloud Console.
// VERCEL_PROJECT_PRODUCTION_URL resolves to the auto-generated "-mu" domain,
// which is not registered, so production is pinned to the primary domain.
const PRIMARY_PRODUCTION_URL = 'https://shayona-footwear.vercel.app'

// `next dev` always uses localhost so the Google callback matches the
// registered http://localhost:3000 URI, even when env vars pulled from Vercel
// (VERCEL_ENV, VERCEL_URL, BETTER_AUTH_URL) point at a deployed domain.
const LOCAL_DEV_URL = process.env.LOCAL_AUTH_URL || 'http://localhost:3000'

const baseURL =
  process.env.NODE_ENV === 'development'
    ? LOCAL_DEV_URL
    : process.env.BETTER_AUTH_URL ||
      (process.env.VERCEL_ENV === 'production'
        ? PRIMARY_PRODUCTION_URL
        : process.env.VERCEL_URL
          ? `https://${process.env.VERCEL_URL}`
          : 'http://localhost:3000')

// Static trusted origins — all known production domains
const staticTrustedOrigins: string[] = [
  'https://shayona-footwear.vercel.app',
  'https://shayona-inventory-managment.vercel.app',
  'https://shayona-jpcodebeasts-projects.vercel.app',
  'https://shayona-git-main-jpcodebeasts-projects.vercel.app',
]
if (baseURL && !staticTrustedOrigins.includes(baseURL))
  staticTrustedOrigins.push(baseURL)
if (process.env.VERCEL_URL)
  staticTrustedOrigins.push(`https://${process.env.VERCEL_URL}`)
if (process.env.VERCEL_PROJECT_PRODUCTION_URL)
  staticTrustedOrigins.push(`https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`)

// In development accept any origin — covers localhost, LAN IPs (192.168.x.x),
// phones on the same WiFi, etc. In production the static list is used.
const trustedOrigins =
  process.env.NODE_ENV === 'development'
    ? (request?: Request) => {
        const origin = request?.headers.get('origin') || ''
        return origin ? [origin] : []
      }
    : staticTrustedOrigins

const ADMIN_EMAILS = ['shayonamartsys@gmail.com']

// Roles are stored as a comma-separated list; add "admin" while keeping any
// other assigned roles, and drop the placeholder "user" role.
async function ensureAdminRole(userId: string, email?: string | null) {
  if (!email || !ADMIN_EMAILS.includes(email.toLowerCase())) return
  const { rows } = await pool.query<{ role: string | null }>(
    'SELECT role FROM "user" WHERE id = $1',
    [userId],
  )
  if (rows.length === 0) return
  const roles = (rows[0].role ?? '')
    .split(',')
    .map(r => r.trim())
    .filter(r => r && r !== 'user')
  if (roles.includes('admin')) return
  await pool.query('UPDATE "user" SET role = $1, "updatedAt" = NOW() WHERE id = $2', [
    ['admin', ...roles].join(','),
    userId,
  ])
}

export const auth = betterAuth({
  database: pool,
  databaseHooks: {
    user: {
      create: {
        after: async user => {
          await ensureAdminRole(user.id, user.email)
        },
      },
    },
    session: {
      create: {
        after: async session => {
          const { rows } = await pool.query<{ email: string }>(
            'SELECT email FROM "user" WHERE id = $1',
            [session.userId],
          )
          await ensureAdminRole(session.userId, rows[0]?.email)
        },
      },
    },
  },
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL,
  trustedOrigins,
  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    },
  },
  account: {
    accountLinking: {
      enabled: true,
      // Trust Google's verified email — safe because Google only returns
      // verified emails in the OAuth response.
      trustedProviders: ['google'],
    },
  },
  session: {
    expiresIn: 60 * 60 * 24 * 30, // 30 days
    updateAge: 60 * 60 * 24,       // rolling — extends 1 day on each visit
  },
})
