import Nav from './components/Nav'
import Hero from './components/Hero'
import BeforeAfter from './components/BeforeAfter'
import Marquee from './components/Marquee'
import VideoSection from './components/VideoSection'
import Setup from './components/Setup'
import HowItWorks from './components/HowItWorks'
import Footer from './components/Footer'

export default function App() {
  return (
    <>
      <Nav />
      <main>
        <Hero />
        <BeforeAfter />
        <Marquee />
        <VideoSection />
        <Setup />
        <HowItWorks />
      </main>
      <Footer />
    </>
  )
}
