export default function Hero() {
  return (
    <section className="section-hero">
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
          The Best{' '}
          <img
            src="/claudecode.png"
            alt="Claude Code"
            style={{
              display: 'inline-block',
              height: '1.4em',
              width: 'auto',
              verticalAlign: '-0.35em',
              borderRadius: '0.15em',
              margin: '0 0.15em',
            }}
          />{' '}
          plugin for{' '}
          <img
            src="/googlechrome.png"
            alt="Google Chrome"
            style={{
              display: 'inline-block',
              height: '1em',
              width: 'auto',
              verticalAlign: '-0.18em',
              margin: '0 0.1em',
            }}
          />
        </h1>
      </div>
    </section>
  )
}
