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
    gap: '1rem',
  },
  brand: {
    display: 'flex', alignItems: 'center', gap: '0.5rem',
    fontWeight: 700, fontSize: '1rem', letterSpacing: '-0.01em',
    color: 'var(--text)',
    flexShrink: 0,
  },
  dot: {
    width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
    background: 'linear-gradient(135deg, var(--amber), var(--orange))',
  },
  links: {
    display: 'flex', alignItems: 'center',
    gap: 'clamp(0.7rem, 2vw, 1.4rem)',
    flexWrap: 'wrap', justifyContent: 'flex-end',
  },
  link: {
    fontWeight: 600, fontSize: '0.88rem',
    color: 'var(--muted)',
    transition: 'color 0.15s',
    whiteSpace: 'nowrap',
  },
  cta: {
    fontWeight: 700, fontSize: '0.85rem',
    color: '#fff',
    background: 'linear-gradient(135deg, var(--amber), var(--orange))',
    padding: '0.4rem 0.85rem',
    borderRadius: 8,
    boxShadow: '0 1px 6px rgba(217,119,6,0.25)',
    whiteSpace: 'nowrap',
  },
}

const NAV_LINKS = [
  { href: '/use-cases', label: 'Use cases' },
  { href: '/compare', label: 'Compare' },
  { href: '/faq', label: 'FAQ' },
  { href: 'https://gitlab.com/NeoDrew/chromeflow', label: 'GitLab', external: true },
]

export default function Nav() {
  return (
    <header style={s.shell}>
      <nav style={s.nav}>
        <a href="#top" style={s.brand}>
          <span style={s.dot} />
          Chromeflow
        </a>
        <div style={s.links}>
          {NAV_LINKS.map(l => (
            <a
              key={l.href}
              href={l.href}
              {...(l.external ? { target: '_blank', rel: 'noreferrer' } : {})}
              style={s.link}
              onMouseEnter={e => e.target.style.color = 'var(--text)'}
              onMouseLeave={e => e.target.style.color = 'var(--muted)'}
            >
              {l.label}
            </a>
          ))}
          <a href="#setup" style={s.cta}>
            Install
          </a>
        </div>
      </nav>
    </header>
  )
}
