import { useScrollAnimation } from '../hooks/useScrollAnimation'

const TASKS = [
  {
    icon: '💼',
    title: 'Outreach on LinkedIn',
    body: 'Send a personalised DM to every YC W26 founder. Claude finds them, drafts each note in your voice, pauses for you to send.',
  },
  {
    icon: '🐦',
    title: 'Automate Twitter posting — for free',
    body: 'Schedule a week of tweets and post them on time. No paid API, no Zapier — just your browser.',
  },
  {
    icon: '🎯',
    title: 'Find & apply to jobs that actually fit',
    body: 'Scan AngelList, Wellfound and LinkedIn for matches, tailor a cover letter per role, submit on your behalf.',
  },
  {
    icon: '⚙️',
    title: 'Set up GitHub, Vercel, Supabase, Render…',
    body: 'No MCPs to install. Claude clicks through every dashboard, grabs the keys, writes them to .env.',
  },
  {
    icon: '📺',
    title: 'Mine 1,000 YouTube videos for transcripts',
    body: 'Open each one, pull the transcript, commit them all to a repo with timestamps and metadata.',
  },
  {
    icon: '🔧',
    title: 'Find plumbers, request 5 quotes',
    body: 'Search local pros, fill out their contact forms with your job details, watch the replies roll in.',
  },
  {
    icon: '📧',
    title: 'Triage 200 emails before standup',
    body: 'Read Gmail, draft replies for the ones that need one, flag the rest into Linear.',
  },
  {
    icon: '💰',
    title: 'Watch competitor pricing pages',
    body: 'Check 50 product pages overnight. Diff against yesterday, ping you in Slack when anything changes.',
  },
  {
    icon: '📊',
    title: 'Pull weekly numbers into one sheet',
    body: 'Stripe MRR, Vercel deploys, GA traffic, Posthog signups — into a Google Sheet, every Monday.',
  },
  {
    icon: '🌍',
    title: 'Translate your site into 12 languages',
    body: 'Crawl every page, run translations, push localised versions into your CMS one by one.',
  },
]

const TaskCard = ({ task }) => (
  <div style={{
    flex: '0 0 70vw',
    minWidth: 0,
    marginRight: '1.5rem',
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-lg)',
    padding: '2.25rem 2.75rem',
    boxShadow: 'var(--shadow)',
    display: 'flex',
    alignItems: 'center',
    gap: '2rem',
    minHeight: 200,
  }}>
    <div style={{
      fontSize: '4rem',
      flexShrink: 0,
      lineHeight: 1,
    }} aria-hidden="true">
      {task.icon}
    </div>
    <div style={{ flex: 1, minWidth: 0 }}>
      <h3 style={{
        fontSize: 'clamp(1.35rem, 2.2vw, 1.85rem)',
        fontWeight: 700,
        letterSpacing: '-0.02em',
        lineHeight: 1.2,
        marginBottom: '0.55rem',
      }}>
        {task.title}
      </h3>
      <p style={{
        fontSize: 'clamp(0.95rem, 1.15vw, 1.1rem)',
        color: 'var(--muted)',
        lineHeight: 1.55,
      }}>
        {task.body}
      </p>
    </div>
  </div>
)

export default function InfiniteTasks() {
  const ref = useScrollAnimation()

  return (
    <section ref={ref} style={{
      borderTop: '1px solid var(--border)',
      padding: '5rem 0',
    }}>
      <div className="wrap">
        <p className="fade-up" style={{
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: '0.7rem', letterSpacing: '0.12em',
          textTransform: 'uppercase', color: 'var(--amber)',
          marginBottom: '0.75rem',
        }}>
          What you can do
        </p>
        <h2 className="fade-up delay-1" style={{
          fontSize: 'clamp(1.9rem, 3.5vw, 2.8rem)',
          fontWeight: 700, letterSpacing: '-0.025em',
          marginBottom: '0.75rem',
        }}>
          Do infinite tasks with Chromeflow.
        </h2>
        <p className="fade-up delay-1" style={{
          fontSize: '1rem', color: 'var(--muted)',
          maxWidth: 720, marginBottom: '3rem', lineHeight: 1.6,
        }}>
          Anything you can do in a browser, Claude can do — at your direction,
          on your accounts, while you do something else.
        </p>
      </div>

      <div className="fade-up delay-2 marquee-outer">
        <div className="marquee-track" style={{ animationDuration: '60s' }}>
          {[...TASKS, ...TASKS].map((task, i) => (
            <TaskCard key={i} task={task} />
          ))}
        </div>
      </div>
    </section>
  )
}
