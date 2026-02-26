export default function Footer() {
  return (
    <footer style={{
      borderTop: '1px solid var(--border)',
      background: 'var(--surface-2)',
    }}>
      <div className="wrap" style={{
        padding: '1.25rem 1.5rem',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        flexWrap: 'wrap', gap: '0.75rem',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <span style={{
            width: 7, height: 7, borderRadius: '50%',
            background: 'linear-gradient(135deg, var(--amber), var(--orange))',
            display: 'block',
          }} />
          <span style={{ fontSize: '0.88rem', color: 'var(--muted)', fontWeight: 600 }}>
            Chromeflow
          </span>
        </div>
        <div style={{ display: 'flex', gap: '1.5rem' }}>
          {[
            ['GitHub', 'https://github.com/NeoDrew/chromeflow'],
            ['npm', 'https://www.npmjs.com/package/chromeflow'],
          ].map(([label, href]) => (
            <a key={label} href={href} target="_blank" rel="noreferrer" style={{
              fontSize: '0.85rem', color: 'var(--subtle)',
              transition: 'color 0.15s',
            }}
              onMouseEnter={e => e.target.style.color = 'var(--text)'}
              onMouseLeave={e => e.target.style.color = 'var(--subtle)'}
            >
              {label}
            </a>
          ))}
        </div>
      </div>
    </footer>
  )
}
