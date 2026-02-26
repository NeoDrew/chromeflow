const s = {
  shell: {
    position: 'sticky', top: 0, zIndex: 100,
    backdropFilter: 'blur(16px)',
    background: 'rgba(249,248,244,0.92)',
    borderBottom: '1px solid var(--border)',
  },
  nav: {
    maxWidth: 1100, margin: '0 auto', padding: '0.9rem 1.5rem',
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  },
  brand: {
    display: 'flex', alignItems: 'center', gap: '0.5rem',
    fontWeight: 700, fontSize: '1rem', letterSpacing: '-0.01em',
    color: 'var(--text)',
  },
  dot: {
    width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
    background: 'linear-gradient(135deg, var(--amber), var(--orange))',
  },
  link: {
    fontWeight: 600, fontSize: '0.88rem',
    color: 'var(--muted)',
    transition: 'color 0.15s',
  },
}

export default function Nav() {
  return (
    <header style={s.shell}>
      <nav style={s.nav}>
        <a href="#top" style={s.brand}>
          <span style={s.dot} />
          Chromeflow
        </a>
        <a
          href="https://github.com/NeoDrew/chromeflow"
          target="_blank" rel="noreferrer"
          style={s.link}
          onMouseEnter={e => e.target.style.color = 'var(--text)'}
          onMouseLeave={e => e.target.style.color = 'var(--muted)'}
        >
          GitHub ↗
        </a>
      </nav>
    </header>
  )
}
