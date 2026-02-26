export default function Hero() {
  return (
    <section id="top" style={{ padding: '6rem 0 5rem' }}>
      <div className="wrap" style={{ maxWidth: 760 }}>
        <p className="hero-el" style={{
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: '0.72rem', letterSpacing: '0.12em',
          textTransform: 'uppercase', color: 'var(--amber)',
          marginBottom: '1.25rem',
        }}>
          MCP server · Chrome extension
        </p>

        <h1 className="hero-el" style={{
          fontSize: 'clamp(2.6rem, 5.5vw, 4.2rem)',
          fontWeight: 700, lineHeight: 1.02,
          letterSpacing: '-0.03em',
          marginBottom: '1.5rem',
        }}>
          Claude Code,{' '}
          <span style={{ color: 'var(--amber)' }}>
            now with a browser.
          </span>
        </h1>

        <blockquote className="hero-el" style={{
          borderLeft: '3px solid var(--amber)',
          paddingLeft: '1.1rem',
          margin: '0 0 2.25rem',
          color: 'var(--muted)',
          fontSize: '1.05rem', lineHeight: 1.65,
          fontStyle: 'italic',
        }}>
          "I kept flipping between Claude and Chrome for every setup task —
          so I built a tool. Now I don't."
        </blockquote>

        <div className="hero-el" style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
          <a href="#setup" style={{
            display: 'inline-block',
            background: 'linear-gradient(135deg, var(--amber), var(--orange))',
            color: '#fff', fontWeight: 700,
            padding: '0.7rem 1.4rem', borderRadius: 999,
            fontSize: '0.95rem',
            boxShadow: '0 4px 16px rgba(217,119,6,0.25)',
            transition: 'transform 0.15s, box-shadow 0.15s',
          }}
            onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-1px)'; e.currentTarget.style.boxShadow = '0 8px 24px rgba(217,119,6,0.35)' }}
            onMouseLeave={e => { e.currentTarget.style.transform = ''; e.currentTarget.style.boxShadow = '0 4px 16px rgba(217,119,6,0.25)' }}
          >
            Get Started
          </a>
          <a href="https://github.com/NeoDrew/chromeflow" target="_blank" rel="noreferrer" style={{
            display: 'inline-block',
            border: '1px solid var(--border-2)',
            color: 'var(--muted)',
            padding: '0.7rem 1.4rem', borderRadius: 999,
            fontSize: '0.95rem', fontWeight: 600,
            transition: 'color 0.15s, border-color 0.15s',
          }}
            onMouseEnter={e => { e.currentTarget.style.color = 'var(--text)'; e.currentTarget.style.borderColor = 'var(--amber)' }}
            onMouseLeave={e => { e.currentTarget.style.color = 'var(--muted)'; e.currentTarget.style.borderColor = 'var(--border-2)' }}
          >
            View on GitHub
          </a>
        </div>
      </div>
    </section>
  )
}
