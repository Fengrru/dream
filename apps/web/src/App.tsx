import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Orb } from 'orb-ui'
import type { OrbSignal, OrbState, OrbThemeName } from 'orb-ui'
import {
  DreamClient,
  SIMULATION_DURATION,
  clamp,
  getSimulationFrame,
  signalFromStateVolume,
  type DreamEvent,
  type DreamReportFrame,
  type MemoryRow,
} from './dream-client'
import {
  isRecognitionAvailable,
  isSynthesisAvailable,
  speak,
  startRecognition,
  stopSpeaking,
  type RecognitionHandle,
} from './voice'

const THEMES: OrbThemeName[] = ['circle', 'bars', 'cloud', 'radial', 'debug']
const MONOSPACE_FONT =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace'

type SignalSource = 'dream' | 'simulation'

interface StageFrame {
  mode: 'Dream' | 'Sim'
  state: OrbState
  cognitive: string | null
  volume: number
  wmLoad: number
}

interface LogEntry {
  id: number
  kind: 'encode' | 'reply' | 'dream'
  text: string
}

function speakingDurationMs(text: string): number {
  return clamp(1600 + text.length * 26, 2200, 9000)
}

export default function App() {
  const [theme, setTheme] = useState<OrbThemeName>('cloud')
  const [source, setSource] = useState<SignalSource>('simulation')
  const [connected, setConnected] = useState(false)
  const [input, setInput] = useState('')
  const [dreaming, setDreaming] = useState(false)
  const [log, setLog] = useState<LogEntry[]>([])
  const [lastReport, setLastReport] = useState<DreamReportFrame | null>(null)
  const [memories, setMemories] = useState<MemoryRow[]>([])
  const [forgetting, setForgetting] = useState<MemoryRow[]>([])
  const [panel, setPanel] = useState<'timeline' | 'bin' | null>(null)
  const [listening, setListening] = useState(false)
  const [voiceOn, setVoiceOn] = useState(false)
  const recognition = useRef<RecognitionHandle | null>(null)
  const voiceOnRef = useRef(false)
  voiceOnRef.current = voiceOn

  // Live signal from the gateway.
  const [liveState, setLiveState] = useState<OrbState>('idle')
  const [liveCognitive, setLiveCognitive] = useState<string | null>(null)
  const [liveWmLoad, setLiveWmLoad] = useState(0.08)
  const [liveVolume, setLiveVolume] = useState(0)
  const speakingUntil = useRef(0)

  const simulationStartedAt = useRef(
    typeof performance === 'undefined' ? Date.now() : performance.now(),
  )
  const [simFrame, setSimFrame] = useState(() => getSimulationFrame(simulationStartedAt.current, performance.now()))

  const client = useRef<DreamClient | null>(null)
  const logId = useRef(0)
  const appendLog = useCallback((kind: LogEntry['kind'], text: string) => {
    logId.current += 1
    setLog((prev) => [{ id: logId.current, kind, text }, ...prev].slice(0, 30))
  }, [])

  // Simulation ticker (kept identical to the orb-ui demo's loop).
  useEffect(() => {
    if (source !== 'simulation') return
    let raf = 0
    const tick = () => {
      setSimFrame(getSimulationFrame(simulationStartedAt.current, performance.now()))
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [source])

  // Live gateway connection.
  useEffect(() => {
    if (source !== 'dream') return
    const clientInstance = new DreamClient()
    client.current = clientInstance
    const off = clientInstance.on((e: DreamEvent) => {
      if (e.type === 'hello') {
        setConnected(true)
        if (e.wmLoad !== undefined) setLiveWmLoad(e.wmLoad)
        clientInstance.requestMemories()
      }
      if (e.type === 'state') {
        if (e.state === 'error') {
          setConnected(false)
        } else {
          setLiveState(e.state)
          setLiveCognitive(e.cognitive ?? null)
          if (e.wmLoad !== undefined) setLiveWmLoad(e.wmLoad)
        }
      }
      if (e.type === 'recalled') setLiveCognitive('recalling')
      if (e.type === 'reply') {
        appendLog('reply', e.text)
        if (e.recalled && e.recalled.length > 0) {
          appendLog('encode', `recalled ${e.recalled.length}: ${e.recalled.map((r) => r.content).join(' | ')}`)
        }
        speakingUntil.current = performance.now() + speakingDurationMs(e.text)
        if (voiceOnRef.current) speak(e.text)
      }
      if (e.type === 'encode') {
        if (e.entry.content) appendLog('encode', `[${e.entry.kind ?? 'memory'}] ${e.entry.content}`)
      }
      if (e.type === 'memories') setMemories(e.nodes)
      if (e.type === 'forgetting-bin') setForgetting(e.nodes)
      if (e.type === 'revive-ack') {
        appendLog('encode', e.ok ? `revived from the forgetting bin: ${e.content ?? ''}` : 'revive failed')
        clientInstance.requestForgettingBin()
      }
      if (e.type === 'dream-report') {
        setDreaming(false)
        setLastReport(e.report)
        appendLog(
          'dream',
          `dreamed: replayed ${e.report.replayedEpisodes}, learned ${e.report.skillsFormed.join(', ') || 'no skills'}, merged ${e.report.mergedCount}, faded ${e.report.fadedCount}`,
        )
        clientInstance.requestMemories()
        clientInstance.requestForgettingBin()
      }
    })
    clientInstance.connect()
    return () => {
      off()
      clientInstance.close()
      client.current = null
      setConnected(false)
    }
  }, [source, appendLog])

  // Speaking volume envelope while Dream "talks".
  useEffect(() => {
    if (source !== 'dream' || liveState !== 'speaking') return
    let raf = 0
    const tick = () => {
      const now = performance.now()
      if (now >= speakingUntil.current) {
        setLiveVolume(0)
        setLiveState('idle')
        setLiveCognitive(null)
        return
      }
      const t = now / 1000
      const voice =
        0.5 + Math.sin(t * 8.4) * 0.19 + Math.sin(t * 15.6 + 1.2) * 0.13 + Math.sin(t * 25.2) * 0.07
      setLiveVolume(clamp(voice, 0.05, 0.95))
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [source, liveState])

  const active: StageFrame = useMemo(() => {
    if (source === 'simulation') {
      return {
        mode: 'Sim',
        state: simFrame.state,
        cognitive: null,
        volume: simFrame.volume,
        wmLoad: simFrame.state === 'thinking' ? 0.8 : 0.2,
      }
    }
    return {
      mode: 'Dream',
      state: dreaming ? 'thinking' : liveState,
      cognitive: dreaming ? 'dreaming' : liveCognitive,
      volume: liveVolume,
      wmLoad: liveWmLoad,
    }
  }, [source, simFrame, dreaming, liveState, liveCognitive, liveVolume, liveWmLoad])

  const signal: OrbSignal = signalFromStateVolume(active.state, active.volume)

  const send = useCallback(() => {
    const text = input.trim()
    if (!text || source !== 'dream' || !connected) return
    setInput('')
    if (/^dream (now|cycle|please)$/i.test(text)) {
      setDreaming(true)
      client.current?.send({ type: 'dream' })
      return
    }
    client.current?.send({ type: 'chat', text })
  }, [input, source, connected])

  const runDream = useCallback(() => {
    if (source !== 'dream' || !connected) return
    setDreaming(true)
    client.current?.send({ type: 'dream' })
  }, [source, connected])

  const toggleListening = useCallback(() => {
    if (listening) {
      recognition.current?.stop()
      recognition.current = null
      setListening(false)
      return
    }
    if (source !== 'dream' || !connected) return
    const handle = startRecognition({
      onInterim: (text) => setInput(text),
      onFinal: (text) => {
        setInput('')
        if (text) {
          if (voiceOnRef.current) stopSpeaking()
          client.current?.send({ type: 'chat', text })
        }
      },
      onError: (message) => {
        appendLog('dream', `voice error: ${message}`)
        setListening(false)
      },
      onEnd: () => setListening(false),
    });
    if (handle) {
      recognition.current = handle
      setListening(true)
    }
  }, [listening, source, connected, appendLog])

  const togglePanel = useCallback(
    (next: 'timeline' | 'bin') => {
      setPanel((current) => {
        const target = current === next ? null : next
        if (target === 'timeline') client.current?.requestMemories()
        if (target === 'bin') client.current?.requestForgettingBin()
        return target
      })
    },
    [],
  )

  const revive = useCallback((id: string) => {
    client.current?.revive(id)
  }, [])

  return (
    <div className="home-page">
      <style>{CSS}</style>

      <nav className="site-nav">
        <div className="site-nav__inner">
          <a href="/" className="site-nav__brand">
            <span className="site-nav__brand-mark" aria-hidden="true" />
            dream
          </a>
          <div className="site-nav__actions">
            <div className="site-nav__links">
              <span className="site-nav__link">memory-centric agent</span>
            </div>
            <span
              className="github-star-button"
              style={{ cursor: 'default' }}
              title="Kernel gateway: ws://127.0.0.1:7333"
            >
              <span
                className="site-nav__brand-mark"
                style={{
                  background: connected ? '#7ef2b6' : '#5a5a5a',
                  boxShadow: connected ? '0 0 12px rgba(126, 242, 182, 0.8)' : 'none',
                  marginRight: 0,
                }}
                aria-hidden="true"
              />
              <span style={{ marginLeft: 8 }}>{connected ? 'gateway live' : 'gateway off'}</span>
            </span>
          </div>
        </div>
      </nav>

      <main>
        <section className="home-hero">
          <div className="hero-copy">
            <div className="section-eyebrow">Memory kernel · Everything is a plugin</div>
            <h1>
              An agent that <span>remembers you.</span>
            </h1>
            <p className="hero-copy__lede">
              Dream's kernel is a human-inspired memory system: it encodes what you say, recalls it
              in later sessions, learns skills from repetition, and consolidates everything while
              idle — it dreams. Powered by DeepSeek reasoning behind a single-pipeline memory core.
            </p>
            <div className="hero-copy__actions">
              <div className="install-command">
                <code>pnpm cli -- serve --db memory.db</code>
              </div>
            </div>
            <div className="hero-providers" aria-label="Runtime">
              <span>Memory</span>
              <span>SQLite · unified space</span>
              <span>Reasoning</span>
              <span>DeepSeek</span>
              <span>UI</span>
              <span>orb-ui (controlled mode)</span>
            </div>
          </div>

          <div id="demo" className="voice-stage">
            <div className="voice-stage__header">
              <span className="voice-stage__title">Dream cognitive surface</span>
              <span className="voice-stage__live">
                <span className="voice-stage__live-dot" aria-hidden="true" />
                {source === 'dream' ? (connected ? 'Kernel live' : 'Reconnecting…') : 'Simulated signal'}
              </span>
            </div>

            <div className="voice-stage__surface">
              <Orb theme={theme} size={280} signal={signal} data-testid="dream-orb" />
              <div className="voice-stage__status" aria-label="Current cognitive signal">
                <span data-testid="dream-mode">{active.mode}</span>
                <span data-testid="dream-cognitive">{active.cognitive ?? active.state}</span>
                <span data-testid="dream-wm">wm {(active.wmLoad * 100).toFixed(0)}%</span>
              </div>
            </div>

            <div className="voice-stage__controls">
              <div className="dream-chat">
                <span className="control-label">Talk to dream {source === 'dream' ? '' : '(switch to dream live)'}</span>
                <div className="dream-chat__row">
                  <input
                    className="dream-chat__input"
                    value={input}
                    placeholder={
                      source === 'dream'
                        ? 'My name is Ada and I live in Seattle'
                        : 'Switch the signal source to “Dream” to chat'
                    }
                    onChange={(event) => setInput(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') send()
                    }}
                    disabled={source !== 'dream'}
                  />
                  <button
                    type="button"
                    className={`dream-chat__send dream-chat__send--mic ${listening ? 'is-listening' : ''}`}
                    onClick={toggleListening}
                    disabled={source !== 'dream' || !isRecognitionAvailable()}
                    title={isRecognitionAvailable() ? 'Speak to Dream' : 'Speech recognition unavailable in this browser'}
                  >
                    {listening ? '● Listening' : 'Mic'}
                  </button>
                  <button
                    type="button"
                    className={`dream-chat__send dream-chat__send--dim ${voiceOn ? 'is-on' : ''}`}
                    onClick={() => {
                      setVoiceOn((v) => {
                        if (v) stopSpeaking()
                        return !v
                      })
                    }}
                    disabled={!isSynthesisAvailable()}
                    title="Speak replies aloud"
                  >
                    {voiceOn ? 'Voice ✓' : 'Voice'}
                  </button>
                  <button type="button" className="dream-chat__send" onClick={send}>
                    Send
                  </button>
                  <button
                    type="button"
                    className="dream-chat__send dream-chat__send--dim"
                    onClick={runDream}
                    title="Run a consolidation (dream) cycle now"
                  >
                    Dream
                  </button>
                </div>
              </div>

              <div className="voice-stage__toolbar">
                <div>
                  <span className="control-label">Memory</span>
                  <div className="segmented-control" role="group" aria-label="Memory panels">
                    <button
                      type="button"
                      className="segmented-button"
                      aria-pressed={panel === 'timeline'}
                      onClick={() => togglePanel('timeline')}
                      disabled={source !== 'dream'}
                    >
                      Timeline ({memories.length})
                    </button>
                    <button
                      type="button"
                      className="segmented-button"
                      aria-pressed={panel === 'bin'}
                      onClick={() => togglePanel('bin')}
                      disabled={source !== 'dream'}
                    >
                      Forgetting bin ({forgetting.length})
                    </button>
                  </div>
                </div>
              </div>

              {panel && (
                <div className="dream-panel" aria-label={panel === 'timeline' ? 'Memory timeline' : 'Forgetting bin'}>
                  {(panel === 'timeline' ? memories : forgetting).length === 0 && (
                    <p className="dream-panel__empty">
                      {panel === 'timeline'
                        ? 'No memories yet — tell Dream something about yourself.'
                        : 'Nothing is fading right now.'}
                    </p>
                  )}
                  {(panel === 'timeline' ? memories : forgetting).map((row) => (
                    <div key={row.id} className="dream-panel__row">
                      <span className="dream-panel__kind">{row.kind}</span>
                      <span className="dream-panel__content">{row.content}</span>
                      <span className="dream-panel__meta">
                        s {row.strength.toFixed(2)} · i {row.importance.toFixed(2)}
                        {panel === 'bin' && (
                          <button type="button" className="dream-panel__revive" onClick={() => revive(row.id)}>
                            revive
                          </button>
                        )}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              <div className="voice-stage__toolbar">
                <div>
                  <span className="control-label">Visual theme</span>
                  <div className="segmented-control" role="group" aria-label="Visual theme">
                    {THEMES.map((nextTheme) => (
                      <button
                        key={nextTheme}
                        type="button"
                        className="segmented-button"
                        aria-pressed={theme === nextTheme}
                        onClick={() => setTheme(nextTheme)}
                      >
                        {nextTheme}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <span className="control-label">Signal source</span>
                  <div className="segmented-control" role="group" aria-label="Signal source">
                    {(
                      [
                        { id: 'dream', label: 'Dream live' },
                        { id: 'simulation', label: 'Simulation' },
                      ] as const
                    ).map(({ id, label }) => (
                      <button
                        key={id}
                        type="button"
                        className="segmented-button"
                        aria-pressed={source === id}
                        onClick={() => setSource(id)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {log.length > 0 && (
                <div className="dream-transcript" aria-label="Dream log">
                  {log.map((entry) => (
                    <div key={entry.id} className={`dream-transcript__row dream-transcript__row--${entry.kind}`}>
                      <span className="dream-transcript__tag">
                        {entry.kind === 'dream' ? 'dream' : entry.kind === 'reply' ? 'dream ›' : 'memory'}
                      </span>
                      <span className="dream-transcript__text">{entry.text}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </section>

        <section className="proof-strip" aria-label="Dream qualities">
          <div className="proof-strip__inner">
            <div className="proof-point">
              <span className="proof-point__value">Cross-session</span>
              <span className="proof-point__label">Unified memory</span>
              <span className="proof-point__detail">One conversation is never one memory</span>
            </div>
            <div className="proof-point">
              <span className="proof-point__value">Implicit</span>
              <span className="proof-point__label">Skills from repetition</span>
              <span className="proof-point__detail">Learned tasks run with zero LLM calls</span>
            </div>
            <div className="proof-point">
              <span className="proof-point__value">Dream cycle</span>
              <span className="proof-point__label">Consolidation while idle</span>
              <span className="proof-point__detail">Replay · abstract · merge · forget</span>
            </div>
            <div className="proof-point">
              <span className="proof-point__value">One door</span>
              <span className="proof-point__label">Single memory pipeline</span>
              <span className="proof-point__detail">Scrubbed, quarantined, tombstone-audited</span>
            </div>
          </div>
        </section>

        {lastReport && (
          <section className="dream-report" aria-label="Last dream report">
            <div className="dream-report__inner">
              <div className="section-eyebrow">Last dream report</div>
              <div className="dream-report__grid">
                <Metric label="Episodes replayed" value={String(lastReport.replayedEpisodes)} />
                <Metric label="Patterns abstracted" value={lastReport.abstractions.join(', ') || '—'} />
                <Metric label="Skills formed" value={lastReport.skillsFormed.join(', ') || '—'} />
                <Metric label="Skills updated" value={lastReport.skillsUpdated.join(', ') || '—'} />
                <Metric label="Episodes merged" value={String(lastReport.mergedCount)} />
                <Metric label="Memories faded" value={String(lastReport.fadedCount)} />
              </div>
            </div>
          </section>
        )}
      </main>

      <footer className="site-footer">
        <div className="site-footer__legal" style={{ maxWidth: 1080 }}>
          <span>MIT License — Dream</span>
          <span>
            UI built on{' '}
            <a href="https://github.com/exprmntl/orb-ui" target="_blank" rel="noreferrer">
              orb-ui
            </a>{' '}
            · reasoning by{' '}
            <a href="https://www.deepseek.com" target="_blank" rel="noreferrer">
              DeepSeek
            </a>
          </span>
        </div>
      </footer>
    </div>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="dream-report__metric">
      <span className="proof-point__value">{value}</span>
      <span className="proof-point__label">{label}</span>
    </div>
  )
}

const CSS = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { background: #0a0a0a; margin: 0; }
  button, input, a { font: inherit; }
  button { color: inherit; }

  .home-page {
    background:
      radial-gradient(circle at 78% 5%, rgba(82, 156, 255, 0.09), transparent 30rem),
      #0a0a0a;
    color: #fff;
    font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    min-height: 100vh;
  }

  .site-nav {
    backdrop-filter: blur(18px);
    background: rgba(10, 10, 10, 0.78);
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    position: sticky;
    top: 0;
    z-index: 100;
  }
  .site-nav__inner {
    align-items: center;
    display: flex;
    gap: 28px;
    justify-content: space-between;
    margin: 0 auto;
    max-width: 1080px;
    min-height: 68px;
    padding: 0 32px;
  }
  .site-nav__brand {
    align-items: center;
    color: #fff;
    display: inline-flex;
    font-size: 18px;
    font-weight: 760;
    letter-spacing: -0.03em;
    text-decoration: none;
  }
  .site-nav__brand-mark {
    background: #8bc7ff;
    border-radius: 50%;
    box-shadow: 0 0 18px rgba(87, 174, 255, 0.55);
    height: 7px;
    margin-right: 9px;
    width: 7px;
  }
  .site-nav__actions, .site-nav__links { align-items: center; display: flex; }
  .site-nav__actions { gap: 22px; }
  .site-nav__link {
    color: #858585;
    font-size: 13px;
    text-decoration: none;
    transition: color 160ms ease;
  }
  .github-star-button {
    align-items: center;
    background: linear-gradient(180deg, #202327, #17191c);
    border: 1px solid #353a3f;
    border-radius: 9px;
    box-shadow: 0 8px 26px rgba(0, 0, 0, 0.26), inset 0 1px rgba(255, 255, 255, 0.045);
    color: #f3f3f3;
    display: inline-flex;
    font-size: 11px;
    font-weight: 690;
    gap: 7px;
    justify-content: center;
    line-height: 1;
    min-height: 38px;
    padding: 0 13px;
    white-space: nowrap;
  }

  .home-hero {
    align-items: center;
    display: grid;
    gap: clamp(44px, 7vw, 82px);
    grid-template-columns: minmax(0, 0.95fr) minmax(420px, 1.05fr);
    margin: 0 auto;
    max-width: 1080px;
    padding: clamp(70px, 9vw, 112px) 32px 70px;
  }
  .section-eyebrow {
    color: #78b9f2;
    font-family: ${MONOSPACE_FONT};
    font-size: 10px;
    font-weight: 650;
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }
  .hero-copy h1 {
    font-size: clamp(52px, 6.6vw, 76px);
    letter-spacing: -0.06em;
    line-height: 0.96;
    margin: 18px 0 0;
    max-width: 580px;
  }
  .hero-copy h1 span {
    background: linear-gradient(100deg, #fff 10%, #a9d6ff 90%);
    background-clip: text;
    color: transparent;
  }
  .hero-copy__lede {
    color: #9b9b9b;
    font-size: 16px;
    line-height: 1.75;
    margin: 26px 0 0;
    max-width: 530px;
  }
  .hero-copy__actions { margin-top: 34px; }
  .install-command {
    align-items: center;
    background: rgba(16, 16, 16, 0.9);
    border: 1px solid #292929;
    border-radius: 10px;
    display: flex;
    min-height: 46px;
    overflow: hidden;
    width: fit-content;
  }
  .install-command code {
    align-items: center;
    align-self: stretch;
    color: #c7c7c7;
    display: flex;
    font-family: ${MONOSPACE_FONT};
    font-size: 12px;
    padding: 0 15px;
    white-space: nowrap;
  }
  .hero-providers {
    align-items: center;
    color: #5d5d5d;
    display: flex;
    flex-wrap: wrap;
    font-family: ${MONOSPACE_FONT};
    font-size: 10px;
    gap: 8px 12px;
    letter-spacing: 0.02em;
    margin-top: 34px;
  }
  .hero-providers span:nth-child(odd) { color: #9a9a9a; }

  .voice-stage {
    background:
      radial-gradient(circle at 50% 34%, rgba(83, 148, 255, 0.17), transparent 34%),
      linear-gradient(160deg, rgba(20, 22, 25, 0.98), rgba(12, 12, 12, 0.98));
    border: 1px solid #292c30;
    border-radius: 28px;
    box-shadow: 0 34px 90px rgba(0, 0, 0, 0.42), inset 0 1px rgba(255, 255, 255, 0.025);
    min-width: 0;
    overflow: hidden;
  }
  .voice-stage__header {
    align-items: center;
    border-bottom: 1px solid #25282b;
    display: flex;
    justify-content: space-between;
    min-height: 58px;
    padding: 0 22px;
  }
  .voice-stage__title { color: #d9d9d9; font-size: 12px; font-weight: 650; }
  .voice-stage__live {
    align-items: center;
    color: #747474;
    display: inline-flex;
    font-family: ${MONOSPACE_FONT};
    font-size: 9px;
    gap: 7px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }
  .voice-stage__live-dot {
    background: #7fc2ff;
    border-radius: 50%;
    box-shadow: 0 0 10px rgba(88, 179, 255, 0.8);
    height: 6px;
    width: 6px;
  }
  .voice-stage__surface {
    align-items: center;
    display: flex;
    flex-direction: column;
    justify-content: center;
    min-height: 360px;
    padding: 32px 22px 24px;
  }
  .voice-stage__status { align-items: center; display: flex; gap: 8px; margin-top: 16px; }
  .voice-stage__status span {
    background: rgba(255, 255, 255, 0.035);
    border: 1px solid #292929;
    border-radius: 999px;
    color: #818181;
    font-family: ${MONOSPACE_FONT};
    font-size: 9px;
    min-width: 70px;
    overflow: hidden;
    padding: 7px 10px;
    text-align: center;
    text-overflow: ellipsis;
    text-transform: uppercase;
    white-space: nowrap;
  }
  .voice-stage__controls {
    background: rgba(8, 8, 8, 0.42);
    border-top: 1px solid #25282b;
    display: grid;
    gap: 18px;
    padding: 20px 22px 22px;
  }
  .voice-stage__toolbar {
    display: grid;
    gap: 18px;
    grid-template-columns: minmax(0, 1fr) auto;
  }
  .control-label {
    color: #5f5f5f;
    display: block;
    font-family: ${MONOSPACE_FONT};
    font-size: 8px;
    letter-spacing: 0.12em;
    margin-bottom: 9px;
    text-transform: uppercase;
  }
  .segmented-control { display: flex; flex-wrap: wrap; gap: 6px; }
  .segmented-button, .dream-chat__send {
    background: #111;
    border: 1px solid #292929;
    border-radius: 7px;
    color: #727272;
    cursor: pointer;
    font-size: 10px;
    min-height: 30px;
    padding: 0 10px;
    transition: background 150ms ease, border-color 150ms ease, color 150ms ease;
  }
  .segmented-button:hover, .segmented-button:focus-visible,
  .dream-chat__send:hover, .dream-chat__send:focus-visible {
    border-color: #454545;
    color: #ddd;
  }
  .segmented-button[aria-pressed='true'] {
    background: #edf6ff;
    border-color: #fff;
    color: #0b1116;
  }

  .dream-chat__row { display: grid; gap: 8px; grid-template-columns: minmax(0, 1fr) auto auto auto auto; }
  .dream-chat__input {
    background: #101010;
    border: 1px solid #292929;
    border-radius: 9px;
    color: #eee;
    font-size: 13px;
    min-height: 38px;
    padding: 0 13px;
  }
  .dream-chat__input:focus { border-color: #4d7191; outline: none; }
  .dream-chat__input:disabled { opacity: 0.45; }
  .dream-chat__send { min-width: 64px; }
  .dream-chat__send--dim { color: #565656; }
  .dream-chat__send--dim.is-on { color: #9fd0ff; border-color: #35414b; }
  .dream-chat__send--mic.is-listening {
    background: #2a1215;
    border-color: #7a2c33;
    color: #ff9aa2;
    animation: dream-pulse 1.2s ease-in-out infinite;
  }
  @keyframes dream-pulse {
    0%, 100% { box-shadow: 0 0 0 rgba(255, 154, 162, 0); }
    50% { box-shadow: 0 0 14px rgba(255, 154, 162, 0.35); }
  }

  .dream-panel {
    border-top: 1px solid #242424;
    display: flex;
    flex-direction: column;
    gap: 2px;
    max-height: 220px;
    overflow-y: auto;
    padding-top: 12px;
  }
  .dream-panel__empty { color: #626262; font-size: 11.5px; margin: 4px 0; }
  .dream-panel__row {
    align-items: baseline;
    border-bottom: 1px solid #1c1e22;
    color: #b9b9b9;
    display: flex;
    font-size: 11.5px;
    gap: 10px;
    line-height: 1.55;
    padding: 5px 0;
  }
  .dream-panel__kind {
    color: #6d6d6d;
    flex-shrink: 0;
    font-family: ${MONOSPACE_FONT};
    font-size: 8.5px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    width: 62px;
  }
  .dream-panel__content { flex: 1; min-width: 0; }
  .dream-panel__meta {
    color: #565656;
    flex-shrink: 0;
    font-family: ${MONOSPACE_FONT};
    font-size: 9px;
    white-space: nowrap;
  }
  .dream-panel__revive {
    background: transparent;
    border: 1px solid #35414b;
    border-radius: 6px;
    color: #9fd0ff;
    cursor: pointer;
    font-size: 9px;
    margin-left: 8px;
    padding: 1px 7px;
  }
  .dream-panel__revive:hover { border-color: #9fd0ff; }

  .dream-transcript {
    border-top: 1px solid #242424;
    display: flex;
    flex-direction: column;
    gap: 2px;
    max-height: 200px;
    overflow-y: auto;
    padding-top: 12px;
  }
  .dream-transcript__row {
    color: #a8a8a8;
    display: flex;
    font-size: 11.5px;
    gap: 10px;
    line-height: 1.6;
  }
  .dream-transcript__tag {
    color: #6d6d6d;
    flex-shrink: 0;
    font-family: ${MONOSPACE_FONT};
    font-size: 8.5px;
    letter-spacing: 0.1em;
    padding-top: 3px;
    text-transform: uppercase;
    width: 64px;
  }
  .dream-transcript__row--reply .dream-transcript__text { color: #e6eef8; }
  .dream-transcript__row--dream .dream-transcript__text { color: #9fd0ff; }

  .proof-strip { margin: 0 auto; max-width: 1080px; padding: 0 32px; }
  .proof-strip__inner {
    border-bottom: 1px solid #242424;
    border-top: 1px solid #242424;
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }
  .proof-point { padding: 26px 24px; }
  .proof-point + .proof-point { border-left: 1px solid #242424; }
  .proof-point__value {
    color: #e8e8e8;
    display: block;
    font-family: ${MONOSPACE_FONT};
    font-size: 13px;
    font-weight: 650;
  }
  .proof-point__label { display: block; font-size: 12px; font-weight: 620; margin-top: 9px; }
  .proof-point__detail { color: #696969; display: block; font-size: 10px; margin-top: 4px; }

  .dream-report { margin: 0 auto; max-width: 1080px; padding: 44px 32px 84px; }
  .dream-report__inner {
    background: linear-gradient(145deg, #121212, #0d0d0d 70%);
    border: 1px solid #242424;
    border-radius: 18px;
    padding: 28px;
  }
  .dream-report__grid {
    display: grid;
    gap: 18px;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    margin-top: 20px;
  }
  .dream-report__metric {
    background: rgba(255, 255, 255, 0.02);
    border: 1px solid #222;
    border-radius: 12px;
    padding: 16px;
  }

  .site-footer { border-top: 1px solid #202020; }
  .site-footer__legal {
    display: flex;
    flex-wrap: wrap;
    gap: 8px 18px;
    justify-content: space-between;
    margin: 0 auto;
    padding: 20px 32px 28px;
  }
  .site-footer__legal span, .site-footer__legal a { color: #5d5d5d; font-size: 10px; }
  .site-footer__legal a { text-decoration: none; }
  .site-footer__legal a:hover { color: #fff; }

  @media (max-width: 900px) {
    .home-hero { grid-template-columns: 1fr; }
    .proof-strip__inner { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .dream-report__grid { grid-template-columns: 1fr; }
  }
`
