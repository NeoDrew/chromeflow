import { useEffect, useRef, useState } from 'react'
import { useScrollAnimation } from '../hooks/useScrollAnimation'

// Brand marks — inline SVGs so we don't add a new asset for every card.
// Sizes are tuned individually because each mark's content/bounding-box ratio differs.

const LogoLinkedIn = () => (
  <svg width="60" height="60" viewBox="0 0 24 24" fill="#0a66c2" aria-hidden="true">
    <path d="M19 0h-14c-2.761 0-5 2.239-5 5v14c0 2.761 2.239 5 5 5h14c2.762 0 5-2.239 5-5v-14c0-2.761-2.238-5-5-5zm-11 19h-3v-11h3v11zm-1.5-12.268c-.966 0-1.75-.79-1.75-1.764s.784-1.764 1.75-1.764 1.75.79 1.75 1.764-.783 1.764-1.75 1.764zm13.5 12.268h-3v-5.604c0-3.368-4-3.113-4 0v5.604h-3v-11h3v1.765c1.396-2.586 7-2.777 7 2.476v6.759z" />
  </svg>
)

const LogoX = () => (
  <svg width="52" height="52" viewBox="0 0 24 24" fill="#000" aria-hidden="true">
    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231 5.45-6.231zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77z" />
  </svg>
)

const LogoYouTube = () => (
  <svg width="84" height="60" viewBox="0 0 24 24" aria-hidden="true">
    <path fill="#FF0000" d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814z" />
    <path fill="#fff" d="M9.545 15.568V8.432L15.818 12l-6.273 3.568z" />
  </svg>
)

const LogoGmail = () => (
  <img src="/gmail.svg" alt="" width="78" height="58" style={{ display: 'block' }} aria-hidden="true" />
)

const LogoGitHub = () => (
  <svg width="56" height="56" viewBox="0 0 24 24" fill="#181717" aria-hidden="true">
    <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
  </svg>
)

const LogoVercel = () => (
  <svg width="62" height="54" viewBox="0 0 24 24" fill="#000" aria-hidden="true">
    <path d="M12 1.608L24 22.392H0L12 1.608z" />
  </svg>
)

const LogoSupabase = () => (
  <svg width="50" height="56" viewBox="0 0 24 24" fill="#3ECF8E" aria-hidden="true">
    <path d="M13.976 9.15h6.156c.795 0 1.207.94.667 1.523l-9.51 10.243c-.665.717-1.844.222-1.806-.764l.241-6.347H3.566c-.795 0-1.207-.94-.667-1.523L12.41 1.04c.665-.717 1.844-.222 1.806.764l-.24 6.347z" />
  </svg>
)

const LogoRender = () => (
  <svg width="56" height="56" viewBox="0 0 24 24" aria-hidden="true">
    <defs>
      <linearGradient id="renderGrad" x1="0" y1="0" x2="24" y2="24" gradientUnits="userSpaceOnUse">
        <stop offset="0" stopColor="#46e3b7" />
        <stop offset="1" stopColor="#23a880" />
      </linearGradient>
    </defs>
    <circle cx="12" cy="12" r="10" fill="url(#renderGrad)" />
    <circle cx="12" cy="12" r="3" fill="#fff" />
  </svg>
)

const LogoStripe = () => (
  <svg width="60" height="56" viewBox="0 0 24 24" fill="#635bff" aria-hidden="true">
    <path d="M13.479 9.883c-1.626-.604-2.512-1.067-2.512-1.84 0-.643.526-1.012 1.466-1.012 1.731 0 3.45.66 4.633 1.243l.689-4.234c-.937-.452-2.836-1.197-5.428-1.197-1.834 0-3.366.476-4.46 1.36-1.142.93-1.732 2.25-1.732 3.864 0 2.929 1.789 4.184 4.703 5.239 1.879.667 2.508 1.146 2.508 1.882 0 .714-.612 1.124-1.726 1.124-1.398 0-3.665-.683-5.18-1.564l-.713 4.288c1.295.733 3.694 1.476 6.183 1.476 1.946 0 3.566-.46 4.665-1.342 1.221-.97 1.86-2.396 1.86-4.124 0-2.998-1.835-4.243-4.842-5.34l-.114-.024z" />
  </svg>
)

const LogoGA = () => (
  <svg width="54" height="56" viewBox="0 0 24 24" fill="#f9ab00" aria-hidden="true">
    <path d="M22.84 2.998v17.999a2.983 2.983 0 0 1-2.967 2.998 2.98 2.98 0 0 1-2.967-2.998V3.123A2.989 2.989 0 0 1 19.81 0a2.983 2.983 0 0 1 3.03 2.998zM12 21c1.657 0 3-1.343 3-3s-1.343-3-3-3-3 1.343-3 3 1.343 3 3 3zm-7.91-9c1.657 0 3-1.343 3-3s-1.343-3-3-3-3 1.343-3 3 1.343 3 3 3z" />
  </svg>
)

const LogoPostHog = () => (
  <svg width="56" height="56" viewBox="0 0 32 32" aria-hidden="true">
    <rect x="2" y="2" width="28" height="28" rx="6" fill="#1d4aff" />
    <path d="M9 22 V12 L14 17 L19 12 V22" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
  </svg>
)

// Abstract amber icons for use cases that don't map to a single brand
const IconBriefcase = () => (
  <svg width="60" height="56" viewBox="0 0 24 24" fill="none" stroke="#d97706" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="2" y="7" width="20" height="14" rx="2" fill="#fff7ed" />
    <path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2" />
    <path d="M2 13h20" />
  </svg>
)

const IconWrench = () => (
  <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="#d97706" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M14.7 6.3a4 4 0 0 0-5.4 5.4l-7 7L4 21l7-7a4 4 0 0 0 5.4-5.4l-2.4 2.4-2-2 2.4-2.4z" fill="#fff7ed" />
  </svg>
)

const IconChart = () => (
  <svg width="64" height="56" viewBox="0 0 24 24" fill="none" stroke="#d97706" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="3" width="18" height="18" rx="2" fill="#fff7ed" />
    <path d="M7 16l4-4 3 3 4-6" />
    <circle cx="17" cy="9" r="1.5" fill="#d97706" stroke="none" />
  </svg>
)

const IconGlobe = () => (
  <svg width="60" height="60" viewBox="0 0 24 24" fill="none" stroke="#d97706" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="10" fill="#fff7ed" />
    <path d="M2 12h20" />
    <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
  </svg>
)

const LogoRow = ({ children, gap = '1.25rem' }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap, flexWrap: 'wrap' }}>
    {children}
  </div>
)

const TASKS = [
  {
    logo: <LogoLinkedIn />,
    title: 'Automate LinkedIn outreach to YC founders',
    body:
      "Send a personalised DM to every YC W26 founder, tailored to their sector and your codebase. Claude reads your pitch.md for context — what you sell, who buys, why they'd care — then writes each message in your tone. Branches beyond LinkedIn: cross-checks the YC company directory, the founder's site, and AngelList to enrich each profile. Pauses for you to approve and send, so you never get flagged for spam. Logs every recipient and outcome to a CSV in your repo, ready to re-target next quarter.",
  },
  {
    logo: <LogoX />,
    title: 'Automate Twitter / X — no paid API',
    body:
      'Schedule a week of tweets and post them on time, straight through your real X account. No paid API tier, no Zapier, no token quotas. Claude reads your content calendar, drafts threads in your voice, and queues them in the X composer at the right times. Branches into the obvious follow-on work: reply to mentions, repost top tweets to LinkedIn, drop links into your Discord. Every tweet appears in the composer before it posts — you see a typo or the wrong link before the world does.',
  },
  {
    logo: <IconBriefcase />,
    title: 'Find & apply to jobs that actually fit',
    body:
      "Scan LinkedIn Jobs, Wellfound, AngelList, YC's Work at a Startup, and Indeed in parallel. Claude filters listings against target_roles.md — stack, stage, comp floor, location — and for each match pulls the JD, drafts a cover letter that cites a specific line from your repo, and fills the application form. You review, edit, send. Every submission logs to a SQLite file so you can ping recruiters two weeks later without rewatching boards. No third-party recruiter dashboard, no leaked CV, no auto-apply spam that gets you rate-limited or banned.",
  },
  {
    logo: (
      <LogoRow>
        <LogoGitHub /><LogoVercel /><LogoSupabase /><LogoRender />
      </LogoRow>
    ),
    title: 'Spin up GitHub, Vercel, Supabase, Render — no MCPs',
    body:
      "Setting up a SaaS stack used to mean ten dashboards, twenty copied keys, and a half-broken .env. Claude does it end-to-end through your real Chrome: creates the GitHub repo, links Vercel, provisions a Supabase project and Postgres role, registers a Render worker, then writes every key into your .env and back into Vercel's env-var dashboard. Pauses on 2FA prompts and credit-card screens. Skip the MCP-per-service treadmill — Chromeflow is one MCP that drives every web UI you already use.",
  },
  {
    logo: <LogoYouTube />,
    title: 'Mine 1,000 YouTube transcripts overnight',
    body:
      "Walk a channel or playlist, open every video, pull the auto-generated or community transcript, and commit it to a repo as Markdown — title, runtime, view count, and timestamps preserved. Claude pages through at human speed in your real Chrome session, so the rate-limiting that breaks scripted scrapers doesn't apply. Pipes the corpus into your project for embeddings, summarisation, or competitor-mention tracking. Resumes after errors. The whole job runs while you sleep; you wake up to a fresh PR with hundreds of hours of transcripts indexed and searchable.",
  },
  {
    logo: <IconWrench />,
    title: 'Find local trades and collect quotes',
    body:
      "Search Google Maps and Checkatrade for plumbers within five miles, dedupe against contacted.csv, then visit each site or Yelp page and fill the contact form with your job spec — boiler model, address, urgency. As replies trickle into your inbox, Claude parses price and availability, ranks them, and drops a summary in your repo's quotes.md. Works for any local-services search: electricians, movers, photographers, dog walkers, locksmiths. You make the human calls; Claude handles the legwork of finding, reaching out, and tracking responses.",
  },
  {
    logo: <LogoGmail />,
    title: 'Triage 200 emails before standup',
    body:
      "Walk your Gmail inbox in priority order, read each unread thread, classify it — reply needed, FYI, spam, waiting on someone — and draft a response where one's warranted. Claude pulls context from your repo: past correspondence, the GitHub issue this email references, the customer's invoice history. The draft reads like you wrote it, not a template. Saves each draft to Gmail so you polish in two minutes per email. Archives the FYIs, snoozes the waiting-on-them ones, opens Linear issues for the action items. Inbox-zero in ten minutes.",
  },
  {
    logo: <IconChart />,
    title: 'Watch 50 competitor pages every night',
    body:
      "Crawl your competitors' pricing, product, and changelog pages overnight in your real Chrome — so paywalls, dashboards, and \"log in to see pricing\" gates all work. Claude records prices, plan names, feature lists, and ship dates, then diffs every page against yesterday's snapshot in your repo. When something material changes — a price cut, a new plan, a removed feature — it opens a Linear ticket with the diff, screenshots, and a one-paragraph summary. You wake up to the day's competitive intel already triaged into your backlog.",
  },
  {
    logo: (
      <LogoRow>
        <LogoStripe /><LogoVercel /><LogoGA /><LogoPostHog />
      </LogoRow>
    ),
    title: 'Pull weekly numbers into one sheet',
    body:
      "Every Monday at 9am, Claude logs into Stripe, Vercel, Google Analytics, PostHog, and Plausible — whichever dashboards your business runs on — and pulls the week's headline numbers: MRR, churn, deploy count, top traffic pages, signup conversion. Writes them into the Google Sheet you already maintain, in the row format you already use, so the historical chart keeps growing. Reads weekly_review.md and appends a one-paragraph commentary tying the numbers to what shipped that week. You arrive at standup with the deck pre-filled.",
  },
  {
    logo: <IconGlobe />,
    title: 'Translate your site into 12 languages',
    body:
      "Crawl every page on your marketing site, pull copy from the HTML, hand it to Claude for translations that respect your tone and your existing localised strings in /locales. Then drive your real CMS — Webflow, Framer, Squarespace, Sanity, Ghost — to create the localised version of each page, paste the translated copy block by block, set the canonical URL, and publish. Pauses on culturally tricky phrases for you to spot-check. Repeats for every language you target. No headless CMS API, no translation-vendor dashboard, no manual paste.",
  },
]

// 3-copy render lets us reset scroll position invisibly when the user (or
// auto-advance) walks off either end — the cards on either side are identical
// so the reset is imperceptible.
const TRIPLE = [...TASKS, ...TASKS, ...TASKS]

const CARD_GAP_PX = 32
const ADVANCE_MS = 2500
const PAUSE_AFTER_INTERACTION_MS = 6000

const TaskCard = ({ task, isExpanded, onToggleExpand }) => {
  // Stop pointer events bubbling to the drag handler — the carousel listens
  // for pointerdown on the track to start dragging, but clicks on the
  // read-more button shouldn't begin a drag.
  const stop = (e) => e.stopPropagation()
  return (
    <div
      data-card
      style={{
        height: isExpanded ? 'auto' : '40vh',
        minHeight: 360,
        scrollSnapAlign: 'center',
        marginRight: `${CARD_GAP_PX}px`,
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-lg)',
        boxShadow: 'var(--shadow)',
        display: 'flex',
        flexDirection: 'column',
        gap: '1.4rem',
        userSelect: 'none',
        alignSelf: 'flex-start',
      }}
    >
      <div style={{
        display: 'flex',
        alignItems: 'center',
        minHeight: 64,
      }}>
        {task.logo}
      </div>
      <h3 style={{
        fontSize: 'clamp(1.5rem, 2.1vw, 2rem)',
        fontWeight: 700,
        letterSpacing: '-0.02em',
        lineHeight: 1.18,
        color: 'var(--text)',
      }}>
        {task.title}
      </h3>
      <p style={{
        fontSize: 'clamp(0.95rem, 1.05vw, 1.05rem)',
        color: 'var(--muted)',
        lineHeight: 1.65,
        flex: isExpanded ? 'unset' : 1,
        overflow: 'hidden',
        display: isExpanded ? 'block' : '-webkit-box',
        WebkitLineClamp: isExpanded ? 'unset' : 5,
        WebkitBoxOrient: 'vertical',
        whiteSpace: 'normal',
      }}>
        {task.body}
      </p>
      <button
        type="button"
        onPointerDown={stop}
        onMouseDown={stop}
        onTouchStart={stop}
        onClick={(e) => { e.stopPropagation(); onToggleExpand() }}
        style={{
          alignSelf: 'flex-start',
          background: 'transparent',
          border: 'none',
          color: 'var(--amber)',
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: '0.78rem',
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          fontWeight: 600,
          cursor: 'pointer',
          padding: 0,
          marginTop: 'auto',
        }}
      >
        {isExpanded ? '↑ Read less' : 'Read more →'}
      </button>
    </div>
  )
}

export default function InfiniteTasks() {
  const ref = useScrollAnimation()
  const trackRef = useRef(null)
  const interactionRef = useRef(0)
  const hoveringRef = useRef(false)
  const dragRef = useRef({ active: false, startX: 0, lastX: 0, startScrollLeft: 0, moved: false })
  const [expandedTaskIdx, setExpandedTaskIdx] = useState(null)
  const expandedRef = useRef(null)
  useEffect(() => { expandedRef.current = expandedTaskIdx }, [expandedTaskIdx])
  const toggleExpand = (taskIdx) => {
    setExpandedTaskIdx((prev) => (prev === taskIdx ? null : taskIdx))
  }

  // Start in the middle copy so we can scroll either direction infinitely
  useEffect(() => {
    const track = trackRef.current
    if (!track) return
    const setInitial = () => {
      const oneThird = track.scrollWidth / 3
      track.style.scrollBehavior = 'auto'
      track.scrollLeft = oneThird
      requestAnimationFrame(() => { track.style.scrollBehavior = '' })
    }
    setInitial()
    // Re-anchor on resize since vw-based card widths change
    const onResize = () => setInitial()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // Seamless loop: when scroll has settled near either end of the 3-copy track,
  // teleport silently to the equivalent position in the middle copy.
  useEffect(() => {
    const track = trackRef.current
    if (!track) return

    let settleTimer = null
    const checkLoop = () => {
      const oneThird = track.scrollWidth / 3
      const twoThirds = oneThird * 2
      if (track.scrollLeft >= twoThirds - 10) {
        track.style.scrollBehavior = 'auto'
        track.scrollLeft -= oneThird
        requestAnimationFrame(() => { track.style.scrollBehavior = '' })
      } else if (track.scrollLeft < oneThird - 10) {
        track.style.scrollBehavior = 'auto'
        track.scrollLeft += oneThird
        requestAnimationFrame(() => { track.style.scrollBehavior = '' })
      }
    }
    const onScroll = () => {
      clearTimeout(settleTimer)
      settleTimer = setTimeout(checkLoop, 160)
    }
    track.addEventListener('scroll', onScroll)
    return () => {
      track.removeEventListener('scroll', onScroll)
      clearTimeout(settleTimer)
    }
  }, [])

  // Auto-advance every 5s unless the user is actively interacting.
  useEffect(() => {
    const id = setInterval(() => {
      const track = trackRef.current
      if (!track) return
      if (expandedRef.current !== null) return
      if (hoveringRef.current) return
      if (Date.now() - interactionRef.current < PAUSE_AFTER_INTERACTION_MS) return
      if (dragRef.current.active) return
      const card = track.querySelector('[data-card]')
      if (!card) return
      const step = card.offsetWidth + CARD_GAP_PX
      track.scrollTo({ left: track.scrollLeft + step, behavior: 'smooth' })
    }, ADVANCE_MS)
    return () => clearInterval(id)
  }, [])

  const markInteraction = () => { interactionRef.current = Date.now() }

  // Mouse / pen drag-to-pan. Touch falls through to the browser's native
  // momentum scroll, which is what users expect on mobile.
  const onPointerDown = (e) => {
    const track = trackRef.current
    if (!track) return
    markInteraction()
    if (e.pointerType === 'touch') return
    if (e.button !== undefined && e.button !== 0) return
    dragRef.current = {
      active: true,
      startX: e.clientX,
      lastX: e.clientX,
      startScrollLeft: track.scrollLeft,
      moved: false,
    }
    track.setPointerCapture?.(e.pointerId)
    track.style.cursor = 'grabbing'
    track.style.scrollSnapType = 'none'
    track.style.scrollBehavior = 'auto'
  }

  const onPointerMove = (e) => {
    const drag = dragRef.current
    if (!drag.active) return
    const track = trackRef.current
    if (!track) return
    drag.lastX = e.clientX
    const dx = e.clientX - drag.startX
    if (Math.abs(dx) > 3) drag.moved = true
    track.scrollLeft = drag.startScrollLeft - dx
  }

  const endDrag = (e) => {
    const drag = dragRef.current
    if (!drag.active) return
    drag.active = false
    const track = trackRef.current
    if (!track) return
    track.releasePointerCapture?.(e.pointerId)
    track.style.cursor = 'grab'

    // Decide target by drag *direction*, not by which card happens to be
    // closest. A small flick should advance one card — the user shouldn't
    // need to drag halfway across the viewport.
    const dx = drag.lastX - drag.startX
    const card = track.querySelector('[data-card]')
    const cardStep = (card?.offsetWidth ?? 0) + CARD_GAP_PX
    const DRAG_THRESHOLD = 30 // px — barely more than an accidental click jiggle

    let target = drag.startScrollLeft
    if (Math.abs(dx) >= DRAG_THRESHOLD && cardStep > 0) {
      const direction = dx < 0 ? 1 : -1 // drag left → advance forward
      const cardsMoved = Math.max(1, Math.round(Math.abs(dx) / cardStep))
      target = drag.startScrollLeft + direction * cardsMoved * cardStep
    }

    track.scrollTo({ left: target, behavior: 'smooth' })

    // Re-enable mandatory snap after the smooth-scroll lands so the next
    // drag starts cleanly. Behavior cleared back to default in the same tick.
    setTimeout(() => {
      track.style.scrollSnapType = 'x mandatory'
      track.style.scrollBehavior = ''
    }, 450)
  }

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
          on your accounts, with your codebase open. Drag to browse, or hover
          to pause and read.
        </p>
      </div>

      <div
        className="fade-up delay-2"
        style={{
          mask: 'linear-gradient(to right, transparent, black 6%, black 94%, transparent)',
          WebkitMask: 'linear-gradient(to right, transparent, black 6%, black 94%, transparent)',
        }}
      >
        <div
          ref={trackRef}
          className="task-track"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onWheel={markInteraction}
          onMouseEnter={() => { hoveringRef.current = true }}
          onMouseLeave={() => { hoveringRef.current = false }}
          style={{
            display: 'flex',
            overflowX: 'auto',
            overflowY: 'hidden',
            scrollSnapType: 'x mandatory',
            cursor: 'grab',
            WebkitOverflowScrolling: 'touch',
            userSelect: 'none',
          }}
        >
          {TRIPLE.map((task, i) => {
            const taskIdx = i % TASKS.length
            return (
              <TaskCard
                key={i}
                task={task}
                isExpanded={expandedTaskIdx === taskIdx}
                onToggleExpand={() => toggleExpand(taskIdx)}
              />
            )
          })}
        </div>
      </div>
    </section>
  )
}
