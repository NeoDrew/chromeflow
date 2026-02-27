export default function Hero() {
  return (
    <section style={{ padding: '8rem 0 6rem', textAlign: 'center' }}>
      <div className="wrap" style={{ maxWidth: 700 }}>
        <p className="hero-el" style={{
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: '0.72rem', letterSpacing: '0.12em',
          textTransform: 'uppercase', color: 'var(--amber)',
          marginBottom: '1.5rem',
        }}>
          MCP server · Chrome extension
        </p>
        <h1 className="hero-el" style={{
          fontSize: 'clamp(3rem, 6.5vw, 5rem)',
          fontWeight: 700, lineHeight: 1.0,
          letterSpacing: '-0.035em',
        }}>
          Let Claude set up{' '}
          <span style={{ color: 'var(--amber)' }}>anything.</span>
        </h1>
      </div>
    </section>
  )
}
