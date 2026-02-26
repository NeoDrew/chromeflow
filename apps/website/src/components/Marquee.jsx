const brands = [
  { name: 'Stripe',     slug: 'stripe' },
  { name: 'Supabase',   slug: 'supabase' },
  { name: 'Vercel',     slug: 'vercel' },
  { name: 'GitHub',     slug: 'github' },
  { name: 'Shopify',    slug: 'shopify' },
  { name: 'Firebase',   slug: 'firebase' },
  { name: 'Cloudflare', slug: 'cloudflare' },
  { name: 'Twilio',     slug: 'twilio' },
  { name: 'Railway',    slug: 'railway' },
  { name: 'Render',     slug: 'render' },
  { name: 'SendGrid',   slug: 'sendgrid' },
  { name: 'Resend',     slug: 'resend' },
  { name: 'Sentry',     slug: 'sentry' },
  { name: 'Linear',     slug: 'linear' },
]

// Duplicate for seamless infinite loop
const items = [...brands, ...brands]

function LogoCard({ name, slug }) {
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: '0.65rem',
      padding: '1.15rem 1.5rem',
      margin: '0 0.45rem',
      background: 'var(--surface)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius)',
      boxShadow: 'var(--shadow-sm)',
      flexShrink: 0,
      userSelect: 'none',
      minWidth: 96,
    }}>
      <img
        src={`https://cdn.simpleicons.org/${slug}`}
        alt={name}
        width={36}
        height={36}
        style={{ objectFit: 'contain', display: 'block' }}
        onError={e => { e.currentTarget.style.display = 'none' }}
      />
      <span style={{
        fontSize: '0.73rem',
        fontWeight: 500,
        color: 'var(--muted)',
        letterSpacing: '-0.01em',
        whiteSpace: 'nowrap',
      }}>
        {name}
      </span>
    </div>
  )
}

export default function Marquee() {
  return (
    <div style={{
      borderTop: '1px solid var(--border)',
      padding: '2.75rem 0',
      background: 'var(--surface-2)',
    }}>
      <p style={{
        fontFamily: 'JetBrains Mono, monospace',
        fontSize: '0.67rem',
        letterSpacing: '0.13em',
        textTransform: 'uppercase',
        color: 'var(--subtle)',
        textAlign: 'center',
        marginBottom: '1.4rem',
      }}>
        Works with any web UI
      </p>

      <div className="marquee-outer">
        <div className="marquee-track">
          {items.map((b, i) => (
            <LogoCard key={`${b.slug}-${i}`} {...b} />
          ))}
        </div>
      </div>
    </div>
  )
}
