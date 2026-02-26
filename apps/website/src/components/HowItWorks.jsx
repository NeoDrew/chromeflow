import { useScrollAnimation } from '../hooks/useScrollAnimation'

const cards = [
  {
    icon: '⚡',
    title: 'Claude acts directly',
    body: 'Buttons, forms, fields Claude knows the answer to — it handles without asking. Save, Continue, Create, prices, URLs, names.',
  },
  {
    icon: '🛑',
    title: 'Pauses for what matters',
    body: 'Passwords, payment details, personal choices — Chromeflow highlights them and waits. You stay in control of anything sensitive.',
  },
  {
    icon: '📋',
    title: 'Writes to .env automatically',
    body: 'API keys and secrets are read from the page and written straight to your .env. No copying, no pasting, no mistakes.',
  },
]

export default function HowItWorks() {
  const ref = useScrollAnimation()

  return (
    <section ref={ref} style={{
      borderTop: '1px solid var(--border)',
      padding: '5rem 0 6rem',
    }}>
      <div className="wrap">
        <p className="fade-up" style={{
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: '0.7rem', letterSpacing: '0.12em',
          textTransform: 'uppercase', color: 'var(--amber)',
          marginBottom: '0.75rem',
        }}>
          How it works
        </p>
        <h2 className="fade-up delay-1" style={{
          fontSize: 'clamp(1.8rem, 3vw, 2.4rem)',
          fontWeight: 700, letterSpacing: '-0.025em',
          marginBottom: '2rem',
        }}>
          Less tab-switching. More shipping.
        </h2>

        <div className="fade-up delay-2" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '1rem', marginBottom: '4rem' }}>
          {cards.map(({ icon, title, body }) => (
            <div key={title} className="card-hover" style={{
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-lg)',
              padding: '1.5rem',
              boxShadow: 'var(--shadow-sm)',
            }}>
              <span style={{ fontSize: '1.3rem', display: 'block', marginBottom: '0.75rem' }}>{icon}</span>
              <h3 style={{ fontWeight: 700, fontSize: '1rem', letterSpacing: '-0.01em', marginBottom: '0.5rem' }}>{title}</h3>
              <p style={{ fontSize: '0.87rem', color: 'var(--muted)', lineHeight: 1.6 }}>{body}</p>
            </div>
          ))}
        </div>

        {/* CTA */}
        <div className="fade-up delay-3" style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-lg)',
          padding: '2.5rem',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: '1.5rem', flexWrap: 'wrap',
          boxShadow: 'var(--shadow)',
        }}>
          <div>
            <h3 style={{ fontSize: '1.4rem', fontWeight: 700, letterSpacing: '-0.02em', marginBottom: '0.4rem' }}>
              Stop context-switching.
            </h3>
            <p style={{ color: 'var(--muted)', fontSize: '0.92rem' }}>
              Open source. One command. Claude has a browser.
            </p>
          </div>
          <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
            <a href="#setup" style={{
              display: 'inline-block',
              background: 'linear-gradient(135deg, var(--amber), var(--orange))',
              color: '#fff', fontWeight: 700,
              padding: '0.65rem 1.3rem', borderRadius: 999,
              fontSize: '0.92rem',
              boxShadow: '0 4px 12px rgba(217,119,6,0.25)',
            }}>
              Get Started
            </a>
            <a href="https://github.com/NeoDrew/chromeflow" target="_blank" rel="noreferrer" style={{
              display: 'inline-block',
              border: '1px solid var(--border-2)',
              color: 'var(--muted)',
              padding: '0.65rem 1.3rem', borderRadius: 999,
              fontSize: '0.92rem', fontWeight: 600,
            }}>
              View on GitHub
            </a>
          </div>
        </div>
      </div>
    </section>
  )
}
