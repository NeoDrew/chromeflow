export default function Privacy() {
  return (
    <main style={{ background: 'var(--bg)', minHeight: '100vh' }}>
      <div className="wrap" style={{ maxWidth: 720, padding: '4rem 1.5rem 6rem' }}>
        <a
          href="/"
          style={{
            display: 'inline-flex', alignItems: 'center', gap: '0.4rem',
            fontSize: '0.88rem', color: 'var(--muted)', marginBottom: '2.5rem',
            transition: 'color 0.15s',
          }}
          onMouseEnter={e => e.currentTarget.style.color = 'var(--text)'}
          onMouseLeave={e => e.currentTarget.style.color = 'var(--muted)'}
        >
          ← Back to home
        </a>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginBottom: '0.75rem' }}>
          <span style={{
            width: 8, height: 8, borderRadius: '50%',
            background: 'linear-gradient(135deg, var(--amber), var(--orange))',
            display: 'block', flexShrink: 0,
          }} />
          <span style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--amber)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
            Chromeflow
          </span>
        </div>

        <h1 style={{ fontSize: '2.2rem', fontWeight: 700, lineHeight: 1.2, marginBottom: '0.5rem' }}>
          Privacy Policy
        </h1>
        <p style={{ color: 'var(--muted)', fontSize: '0.9rem', marginBottom: '3rem' }}>
          Last updated: April 2, 2026
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '2.5rem', color: 'var(--text)', lineHeight: 1.7 }}>

          <section>
            <h2 style={h2}>Overview</h2>
            <p>
              Chromeflow is a browser guidance extension that works alongside Claude Code (Anthropic's CLI tool)
              to help automate browser tasks. This policy explains what data the extension accesses and how it
              is handled.
            </p>
          </section>

          <section>
            <h2 style={h2}>Data the extension accesses</h2>
            <p style={{ marginBottom: '1rem' }}>
              The extension reads and interacts with the content of the active browser tab on demand — for
              example, to find buttons, fill form fields, take screenshots, or read page text. This access
              occurs only when a command is issued by Claude Code running on your local machine.
            </p>
            <p>
              Specifically, the extension may access:
            </p>
            <ul style={ul}>
              <li>The URL and visible content (DOM) of the current tab</li>
              <li>Screenshots of the current tab for visual analysis</li>
              <li>Interactive elements such as inputs, buttons, and links</li>
            </ul>
          </section>

          <section>
            <h2 style={h2}>How data is used</h2>
            <p style={{ marginBottom: '1rem' }}>
              All data accessed by the extension is used solely to carry out the browser automation tasks
              you (or Claude Code on your behalf) have requested. The extension acts as a bridge between
              Claude Code running locally and your browser.
            </p>
            <p>
              Page content and screenshots are passed to your local Claude Code process. From there, they
              may be sent to Anthropic's API as part of a Claude conversation — subject to{' '}
              <a href="https://www.anthropic.com/privacy" target="_blank" rel="noreferrer" style={link}>
                Anthropic's Privacy Policy
              </a>.
            </p>
          </section>

          <section>
            <h2 style={h2}>Data we do not collect</h2>
            <ul style={ul}>
              <li>We do not collect, store, or transmit any browsing history</li>
              <li>We do not track usage analytics or telemetry</li>
              <li>We do not share data with any third parties beyond what is described above</li>
              <li>We do not persist any page data after a task completes</li>
            </ul>
          </section>

          <section>
            <h2 style={h2}>Permissions</h2>
            <p style={{ marginBottom: '1rem' }}>The extension requests the following Chrome permissions:</p>
            <ul style={ul}>
              <li><strong>tabs / activeTab</strong> — to read the URL and interact with the active tab</li>
              <li><strong>scripting</strong> — to inject content scripts that carry out automation actions</li>
              <li><strong>offscreen</strong> — to maintain a persistent WebSocket connection to the local MCP server</li>
              <li><strong>storage</strong> — to persist the user's Claude window assignment preference (which Chrome window chromeflow should control). Stored locally via <code>chrome.storage.local</code> — no data is transmitted externally</li>
              <li><strong>windows</strong> — to query and identify the assigned Claude window so browser actions target the correct window</li>
              <li><strong>debugger</strong> — used by the <code>set_file_input</code> feature to upload files to file input elements via Chrome DevTools Protocol (<code>DOM.setFileInputFiles</code>). This is the only way to programmatically set files on <code>&lt;input type=file&gt;</code> elements, which browsers block from script access for security. The debugger attaches briefly to set the file, then immediately detaches</li>
              <li><strong>host permissions (&lt;all_urls&gt;)</strong> — to operate on any site the user navigates to, since Claude Code workflows can target any URL</li>
            </ul>
          </section>

          <section>
            <h2 style={h2}>Local operation</h2>
            <p>
              Chromeflow communicates exclusively with a local MCP server process running on your machine
              (started by <code>npx chromeflow setup</code>). No data is sent to any remote server operated
              by Chromeflow. Your data stays on your machine except where you explicitly direct Claude Code
              to interact with external services.
            </p>
          </section>

          <section>
            <h2 style={h2}>Contact</h2>
            <p>
              If you have questions about this policy, please open an issue on{' '}
              <a href="https://github.com/NeoDrew/chromeflow" target="_blank" rel="noreferrer" style={link}>
                GitHub
              </a>.
            </p>
          </section>

        </div>
      </div>
    </main>
  )
}

const h2 = {
  fontSize: '1.15rem',
  fontWeight: 700,
  marginBottom: '0.75rem',
  color: 'var(--text)',
}

const ul = {
  paddingLeft: '1.5rem',
  display: 'flex',
  flexDirection: 'column',
  gap: '0.4rem',
  marginTop: '0.75rem',
}

const link = {
  color: 'var(--amber)',
  textDecoration: 'underline',
  textDecorationColor: 'rgba(217,119,6,0.4)',
}
