import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import transcriptRows from './data/transcript.json'
import brandIcon from './assets/brand-icon.svg'
import palCharacter from './assets/pal-character.svg'

const VIDEO_ID = 'CqOfi41LfDw'
const PLAYLIST_ID = 'PLblh5JKOoLUIxGDQs4LFFD--41Vzf-ME1'

// ─── YouTube API ────────────────────────────────────────────────────────────

let ytApiPromise = null

const loadYouTubeIframeApi = () => {
  if (window.YT && window.YT.Player) return Promise.resolve(window.YT)
  if (ytApiPromise) return ytApiPromise

  ytApiPromise = new Promise((resolve) => {
    const previousReady = window.onYouTubeIframeAPIReady
    window.onYouTubeIframeAPIReady = () => {
      if (typeof previousReady === 'function') previousReady()
      resolve(window.YT)
    }
    const existing = document.querySelector('script[src="https://www.youtube.com/iframe_api"]')
    if (!existing) {
      const script = document.createElement('script')
      script.src = 'https://www.youtube.com/iframe_api'
      document.body.appendChild(script)
    }
  })

  return ytApiPromise
}

// ─── AI providers ────────────────────────────────────────────────────────────

const PROVIDERS = { CLAUDE: 'claude', OPENAI: 'openai', GROQ: 'groq' }

const PROVIDER_CYCLE = [PROVIDERS.CLAUDE, PROVIDERS.OPENAI, PROVIDERS.GROQ]
const PROVIDER_LABELS = {
  [PROVIDERS.CLAUDE]: '✦ Claude',
  [PROVIDERS.OPENAI]: '⬡ GPT-4o',
  [PROVIDERS.GROQ]:   '⚡ Groq',
}

const buildSystemPrompt = (currentSeconds) => {
  const mins = Math.floor(currentSeconds / 60)
  const secs = Math.floor(currentSeconds % 60)
  const timeStr = `${mins}:${String(secs).padStart(2, '0')}`

  const recentContext = transcriptRows
    .filter((r) => r.seconds <= currentSeconds)
    .slice(-6)
    .map((r) => `[${r.time}] ${r.text}`)
    .join('\n')

  return `You are Pal, a friendly learning assistant embedded in LearnPal, a video learning app.

The user is watching: "The Essential Main Ideas of Neural Networks" by StatQuest.
Current video position: ${timeStr}

Recent transcript context:
${recentContext || 'Video just started.'}

Help the user understand the video. Be concise (under 150 words unless asked for more), clear, and educational. Use simple language and real-world examples when helpful.`
}

// imageDataUrl: JPEG data-URL of the screen-captured region, or null for text-only turns.
// When present it is attached to the last user message as a vision input so the
// model analyses exactly what the learner selected, not a summary of it.
const callAI = async (provider, messages, currentSeconds, imageDataUrl = null) => {
  const system = buildSystemPrompt(currentSeconds)
  const base64 = imageDataUrl ? imageDataUrl.replace(/^data:image\/\w+;base64,/, '') : null

  // ── Groq ───────────────────────────────────────────────────────────────────
  // Groq's API is OpenAI-compatible. Vision is not supported — the image is
  // omitted and the text prompt carries all context for snap-to-ask turns.
  if (provider === PROVIDERS.GROQ) {
    const groqMessages = messages.map(({ role, content }) => ({ role, content }))
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${import.meta.env.VITE_GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 512,
        messages: [{ role: 'system', content: system }, ...groqMessages],
      }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err?.error?.message ?? `Groq error ${res.status}`)
    }
    const data = await res.json()
    return data.choices[0].message.content
  }

  // ── Claude / OpenAI shared message shape ───────────────────────────────────
  const apiMessages = messages.map(({ role, content }, i) => {
    const isLastUser = role === 'user' && i === messages.length - 1
    if (base64 && isLastUser) {
      if (provider === PROVIDERS.CLAUDE) {
        return {
          role,
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64 } },
            { type: 'text', text: content },
          ],
        }
      }
      if (provider === PROVIDERS.OPENAI) {
        return {
          role,
          content: [
            { type: 'image_url', image_url: { url: imageDataUrl } },
            { type: 'text', text: content },
          ],
        }
      }
    }
    return { role, content }
  })

  if (provider === PROVIDERS.CLAUDE) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': import.meta.env.VITE_ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 512,
        system,
        messages: apiMessages,
      }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err?.error?.message ?? `Claude error ${res.status}`)
    }
    const data = await res.json()
    return data.content[0].text
  }

  if (provider === PROVIDERS.OPENAI) {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${import.meta.env.VITE_OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        max_tokens: 512,
        messages: [{ role: 'system', content: system }, ...apiMessages],
      }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err?.error?.message ?? `OpenAI error ${res.status}`)
    }
    const data = await res.json()
    return data.choices[0].message.content
  }

  throw new Error('Unknown AI provider')
}

// ─── AI quiz generator ────────────────────────────────────────────────────────

const generateQuizQuestion = async (provider, currentSeconds, previousQuestions = []) => {
  const watchedRows = transcriptRows.filter((r) => r.seconds <= currentSeconds)

  if (watchedRows.length < 3) {
    throw new Error('Watch a bit more of the video before generating a quiz question.')
  }

  const transcriptContext = watchedRows
    .map((r) => `[${r.time}] ${r.text}`)
    .join('\n')

  const previousBlock = previousQuestions.length > 0
    ? `\n\nAvoid repeating these questions you already asked:\n${previousQuestions.map((q, i) => `${i + 1}. ${q}`).join('\n')}`
    : ''

  const prompt = `You are a quiz generator for an educational video app.

The user has watched this portion of "The Essential Main Ideas of Neural Networks" by StatQuest:
${transcriptContext}${previousBlock}

Generate exactly ONE multiple-choice quiz question that tests understanding of a specific concept from what was watched.

Respond ONLY with a valid JSON object — no markdown, no explanation, nothing else — in this exact shape:
{
  "question": "...",
  "options": ["...", "...", "...", "..."],
  "correctIndex": 0,
  "explanation": "..."
}

Rules:
- The question must be based strictly on the watched content above
- Exactly 4 options
- correctIndex is 0-based
- The explanation should be 1-2 sentences clarifying why the answer is correct`

  if (provider === PROVIDERS.GROQ) {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${import.meta.env.VITE_GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 512,
        response_format: { type: 'json_object' },
        messages: [{ role: 'user', content: prompt }],
      }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err?.error?.message ?? `Groq error ${res.status}`)
    }
    const data = await res.json()
    return JSON.parse(data.choices[0].message.content)
  }

  if (provider === PROVIDERS.CLAUDE) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': import.meta.env.VITE_ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 512,
        messages: [{ role: 'user', content: prompt }],
      }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err?.error?.message ?? `Claude error ${res.status}`)
    }
    const data = await res.json()
    return JSON.parse(data.content[0].text)
  }

  if (provider === PROVIDERS.OPENAI) {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${import.meta.env.VITE_OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        max_tokens: 512,
        response_format: { type: 'json_object' },
        messages: [{ role: 'user', content: prompt }],
      }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err?.error?.message ?? `OpenAI error ${res.status}`)
    }
    const data = await res.json()
    return JSON.parse(data.choices[0].message.content)
  }

  throw new Error('Unknown AI provider')
}

// ─── Snap-to-ask: real screen capture of the selected region ────────────────
//
// Uses the Screen Capture API (getDisplayMedia) to grab one frame from the
// current tab, then crops it precisely to the selection rect.
//
// Returns a JPEG data-URL of the cropped region, or null if the user cancels
// the browser permission dialog or if the API is unavailable.
//
// Coordinate mapping:
//   The captured video stream width/height covers the full viewport.
//   We scale the CSS-pixel selection rect by (streamW / innerWidth) to get
//   the correct pixel offset inside the stream frame.

const captureScreenRegion = async (selectionRect, stageEl) => {
  if (!navigator.mediaDevices?.getDisplayMedia) return null
  if (!stageEl) return null

  const stageRect = stageEl.getBoundingClientRect()

  let stream
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: 'browser', frameRate: { ideal: 1 } },
      audio: false,
      // Chrome 107+: prefer the current tab in the picker
      preferCurrentTab: true,
      selfBrowserSurface: 'include',
    })
  } catch {
    return null  // user dismissed the dialog or permission denied
  }

  return new Promise((resolve) => {
    const video = document.createElement('video')
    video.srcObject = stream
    video.muted = true

    video.onloadedmetadata = () => {
      video.play()

      // Two rAF ticks guarantee the first decoded frame is drawn
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const vW = video.videoWidth
        const vH = video.videoHeight

        // Scale factor: stream pixels per CSS viewport pixel
        const scaleX = vW / window.innerWidth
        const scaleY = vH / window.innerHeight

        // The selection rect is in player-stage-local coordinates.
        // Convert to viewport coordinates, then to stream coordinates.
        const cropX = Math.round((stageRect.left + selectionRect.left) * scaleX)
        const cropY = Math.round((stageRect.top  + selectionRect.top)  * scaleY)
        const cropW = Math.max(4, Math.round(selectionRect.width  * scaleX))
        const cropH = Math.max(4, Math.round(selectionRect.height * scaleY))

        const canvas = document.createElement('canvas')
        canvas.width  = cropW
        canvas.height = cropH
        const ctx = canvas.getContext('2d')
        ctx.drawImage(video, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH)

        stream.getTracks().forEach((t) => t.stop())
        video.srcObject = null

        resolve(canvas.toDataURL('image/jpeg', 0.92))
      }))
    }

    video.onerror = () => {
      stream.getTracks().forEach((t) => t.stop())
      resolve(null)
    }
  })
}

// ─── Static data ─────────────────────────────────────────────────────────────

const quickSuggestions = [
  'Give me a summary in simple terms',
  'Explain the topic in simple terms',
  'Explain with a real life example',
]

// ─── Component ───────────────────────────────────────────────────────────────

function App() {
  // Refs
  const playerHostRef = useRef(null)
  const playerRef = useRef(null)
  const playbackPollRef = useRef(null)
  const transcriptListRef = useRef(null)
  const transcriptItemRefs = useRef(new Map())
  const mainColumnRef = useRef(null)
  const playerStageRef = useRef(null)
  const chatMessagesRef = useRef(null)
  const isCompactRef = useRef(false)
  const isPlayingRef = useRef(false)
  const controlsTimerRef = useRef(null)
  const progressRef = useRef(null)
  const isSeekingRef = useRef(false)
  const playerControlsModeRef = useRef('custom')  // mirrors state for use inside effects
  const savedTimeRef = useRef(0)                   // preserves position across player reinit
  const settingsPanelRef = useRef(null)
  const gearBtnRef = useRef(null)
  const transcriptsHeaderRef = useRef(null)
  const userScrolledRef = useRef(false)            // true while user is manually scrolling transcript
  const userScrollTimerRef = useRef(null)          // resets userScrolledRef after 4s of inactivity

  // UI state
  const [chatInput, setChatInput] = useState('')
  const [mode, setMode] = useState('default_viewing')
  const [selectionRect, setSelectionRect] = useState(null)
  const [dragStart, setDragStart] = useState(null)
  const [dragCurrent, setDragCurrent] = useState(null)
  const [snapPrompt, setSnapPrompt] = useState('')
  // snippetContext lives during the selection flow and is attached to the chat message on submit.
  // Shape: { timestampSeconds, timestampStr, region, stageW, stageH, transcriptSegment }
  // All fields are available to the future backend integration.
  const [snippetContext, setSnippetContext] = useState(null)
  // Screen capture sub-states
  const [isCapturing, setIsCapturing] = useState(false)
  const [captureError, setCaptureError] = useState(null)
  const [currentQuiz, setCurrentQuiz] = useState(null)
  const [quizLoading, setQuizLoading] = useState(false)
  const [quizError, setQuizError] = useState(null)
  const [selectedOption, setSelectedOption] = useState(null)
  const [askedQuestions, setAskedQuestions] = useState([])
  const [currentPlaybackSeconds, setCurrentPlaybackSeconds] = useState(0)
  const [activeTranscriptId, setActiveTranscriptId] = useState(transcriptRows[0]?.id ?? '')

  // AI state
  const [aiProvider, setAiProvider] = useState(PROVIDERS.GROQ)
  const [messages, setMessages] = useState([])
  const [isLoading, setIsLoading] = useState(false)
  const [aiError, setAiError] = useState(null)

  // Sticky player state — no stageHeight state; CSS does the animation
  const [isCompact, setIsCompact] = useState(false)

  // Custom controls state
  const [isPlaying, setIsPlaying] = useState(false)
  const [duration, setDuration] = useState(0)
  const [volume, setVolume] = useState(100)
  const [isMuted, setIsMuted] = useState(false)
  const [playbackRate, setPlaybackRate] = useState(1)
  const [showControls, setShowControls] = useState(true)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [showSpeedMenu, setShowSpeedMenu] = useState(false)

  // Settings state
  const [playerControlsMode, setPlayerControlsMode] = useState('custom') // 'custom' | 'native'
  const [showSettings, setShowSettings] = useState(false)
  const [playerKey, setPlayerKey] = useState(0)  // increment to reinit player with new controls value

  // Derived
  const isQuizOpen = mode === 'quiz_open' || mode === 'quiz_feedback' || mode === 'quiz_loading'
  const isSelectionFlow = mode === 'selection_mode' || mode === 'selection_confirm'
  const seekPercent = duration > 0 ? (currentPlaybackSeconds / duration) * 100 : 0

  // ── YouTube player setup ──────────────────────────────────────────────────

  useEffect(() => {
    let disposed = false

    const startPlaybackPolling = () => {
      window.clearInterval(playbackPollRef.current)
      playbackPollRef.current = window.setInterval(() => {
        const player = playerRef.current
        if (!player || typeof player.getCurrentTime !== 'function') return
        const current = player.getCurrentTime()
        if (Number.isFinite(current)) setCurrentPlaybackSeconds(current)
      }, 500)
    }

    const initPlayer = async () => {
      await loadYouTubeIframeApi()
      if (disposed || !playerHostRef.current || !window.YT?.Player) return

      playerRef.current = new window.YT.Player(playerHostRef.current, {
        host: 'https://www.youtube-nocookie.com',
        videoId: VIDEO_ID,
        playerVars: {
          controls: playerControlsModeRef.current === 'native' ? 1 : 0,
          rel: 0,
          modestbranding: 1,
          iv_load_policy: 3,
          playsinline: 1,
          list: PLAYLIST_ID,
          autoplay: 0,
        },
        events: {
          onReady: (e) => {
            startPlaybackPolling()
            // Restore position after a controls-mode switch
            if (savedTimeRef.current > 0) {
              e.target.seekTo(savedTimeRef.current, true)
              savedTimeRef.current = 0
            }
            const d = e.target.getDuration()
            if (d > 0) setDuration(d)
            setVolume(e.target.getVolume())
            setIsMuted(e.target.isMuted())
          },
          onStateChange: (e) => {
            const playing = e.data === 1
            isPlayingRef.current = playing
            setIsPlaying(playing)
            const d = e.target.getDuration()
            if (d > 0) setDuration(d)
            // Auto-hide timer only relevant for custom controls
            if (playerControlsModeRef.current === 'custom') {
              if (playing) {
                clearTimeout(controlsTimerRef.current)
                controlsTimerRef.current = setTimeout(() => setShowControls(false), 3000)
              } else {
                clearTimeout(controlsTimerRef.current)
                setShowControls(true)
              }
            }
          },
        },
      })
    }

    initPlayer()

    return () => {
      disposed = true
      window.clearInterval(playbackPollRef.current)
      clearTimeout(controlsTimerRef.current)
      clearTimeout(userScrollTimerRef.current)
      if (playerRef.current && typeof playerRef.current.destroy === 'function') {
        playerRef.current.destroy()
      }
      playerRef.current = null
    }
  }, [playerKey])  // playerKey changes trigger a full reinit with the new controls value

  // ── Transcript sync ───────────────────────────────────────────────────────

  useEffect(() => {
    if (!transcriptRows.length) return
    let currentId = transcriptRows[0].id
    for (let i = 0; i < transcriptRows.length; i += 1) {
      if (currentPlaybackSeconds >= transcriptRows[i].seconds) {
        currentId = transcriptRows[i].id
      } else {
        break
      }
    }
    setActiveTranscriptId(currentId)
  }, [currentPlaybackSeconds])

  useEffect(() => {
    if (userScrolledRef.current) return          // user is exploring — don't interrupt
    const list = transcriptListRef.current
    const activeNode = transcriptItemRefs.current.get(activeTranscriptId)
    if (!list || !activeNode) return

    // Scroll within the transcript list so the active row is at the top (with 8px padding).
    const listRect = list.getBoundingClientRect()
    const activeRect = activeNode.getBoundingClientRect()
    const target = list.scrollTop + (activeRect.top - listRect.top) - 8

    list.scrollTo({ top: Math.max(target, 0), behavior: 'smooth' })
  }, [activeTranscriptId])

  // ── Chat auto-scroll ──────────────────────────────────────────────────────

  useEffect(() => {
    const el = chatMessagesRef.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [messages, isLoading])

  // ── Fullscreen sync ───────────────────────────────────────────────────────

  useEffect(() => {
    const onFsChange = () => setIsFullscreen(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', onFsChange)
    return () => document.removeEventListener('fullscreenchange', onFsChange)
  }, [])

  // ── Sticky shrinking player ───────────────────────────────────────────────

  const handleMainScroll = useCallback(() => {
    const el = mainColumnRef.current
    if (!el) return
    if (!isCompactRef.current && el.scrollTop > 1) {
      isCompactRef.current = true
      setIsCompact(true)
    } else if (isCompactRef.current && el.scrollTop < 1) {
      isCompactRef.current = false
      setIsCompact(false)
    }
  }, [])

  const handleTranscriptScroll = useCallback(() => {
    // Any manual scroll in the transcript list pauses auto-sync for 4s
    userScrolledRef.current = true
    clearTimeout(userScrollTimerRef.current)
    userScrollTimerRef.current = setTimeout(() => {
      userScrolledRef.current = false
    }, 4000)
  }, [])

  // ── Settings panel ────────────────────────────────────────────────────────

  useEffect(() => {
    if (!showSettings) return
    const close = (e) => {
      if (settingsPanelRef.current?.contains(e.target)) return
      if (gearBtnRef.current?.contains(e.target)) return
      setShowSettings(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [showSettings])

  const switchPlayerControls = (next) => {
    if (next === playerControlsMode) { setShowSettings(false); return }
    savedTimeRef.current = playerRef.current?.getCurrentTime?.() ?? 0
    playerControlsModeRef.current = next
    setPlayerControlsMode(next)
    setShowControls(true)
    setShowSettings(false)
    setPlayerKey((k) => k + 1)   // triggers effect cleanup + reinit
  }

  // ── Custom player controls ────────────────────────────────────────────────

  const formatTime = (secs) => {
    const s = Math.floor(secs || 0)
    const m = Math.floor(s / 60)
    const h = Math.floor(m / 60)
    const ss = String(s % 60).padStart(2, '0')
    const mm = String(m % 60).padStart(2, '0')
    return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`
  }

  const togglePlay = () => {
    const p = playerRef.current
    if (!p) return
    isPlayingRef.current ? p.pauseVideo() : p.playVideo()
  }

  const seekRelative = (delta) => {
    const p = playerRef.current
    if (!p) return
    const t = Math.max(0, (p.getCurrentTime() || 0) + delta)
    p.seekTo(t, true)
    setCurrentPlaybackSeconds(t)
  }

  const handleStageMouseMove = () => {
    setShowControls(true)
    clearTimeout(controlsTimerRef.current)
    if (isPlayingRef.current) {
      controlsTimerRef.current = setTimeout(() => setShowControls(false), 3000)
    }
  }

  const handleStageMouseLeave = () => {
    clearTimeout(controlsTimerRef.current)
    if (isPlayingRef.current) setShowControls(false)
  }

  const seekToRatio = (clientX) => {
    const rect = progressRef.current?.getBoundingClientRect()
    if (!rect || !duration) return
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
    const t = ratio * duration
    setCurrentPlaybackSeconds(t)
    playerRef.current?.seekTo(t, true)
  }

  const handleSeekPointerDown = (e) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    isSeekingRef.current = true
    seekToRatio(e.clientX)
  }

  const handleSeekPointerMove = (e) => {
    if (!isSeekingRef.current) return
    seekToRatio(e.clientX)
  }

  const handleSeekPointerUp = () => { isSeekingRef.current = false }

  const handleVolumeChange = (val) => {
    const p = playerRef.current
    if (!p) return
    setVolume(val)
    p.setVolume(val)
    if (val === 0) { p.mute(); setIsMuted(true) }
    else if (isMuted) { p.unMute(); setIsMuted(false) }
  }

  const toggleMute = () => {
    const p = playerRef.current
    if (!p) return
    if (isMuted) {
      p.unMute()
      setIsMuted(false)
      if (volume === 0) { setVolume(50); p.setVolume(50) }
    } else {
      p.mute()
      setIsMuted(true)
    }
  }

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      playerStageRef.current?.requestFullscreen()
    } else {
      document.exitFullscreen()
    }
  }

  // ── Live selection rect ───────────────────────────────────────────────────

  const liveSelection = useMemo(() => {
    if (!dragStart || !dragCurrent) return null
    return {
      left: Math.min(dragStart.x, dragCurrent.x),
      top: Math.min(dragStart.y, dragCurrent.y),
      width: Math.abs(dragCurrent.x - dragStart.x),
      height: Math.abs(dragCurrent.y - dragStart.y),
    }
  }, [dragCurrent, dragStart])

  // ── AI messaging ──────────────────────────────────────────────────────────

  // snippet: { imageDataUrl, timestampStr, userPrompt } | null
  // When null the message is a plain chat turn.
  const sendMessage = async (content, snippet = null) => {
    const clean = content.trim()
    if (!clean || isLoading) return

    const userMsg = { role: 'user', content: clean, isSnippet: !!snippet, snippet }
    const updated = [...messages, userMsg]

    setMessages(updated)
    setChatInput('')
    setAiError(null)
    setIsLoading(true)

    try {
      const reply = await callAI(
        aiProvider,
        updated.map(({ role, content: c }) => ({ role, content: c })),
        currentPlaybackSeconds,
        snippet?.imageDataUrl ?? null   // real screen-captured region — null for text turns
      )
      setMessages((prev) => [...prev, { role: 'assistant', content: reply }])
    } catch (err) {
      setAiError(err.message)
    } finally {
      setIsLoading(false)
    }
  }

  // ── Selection handlers ────────────────────────────────────────────────────

  const startSelection = () => {
    // Pause the video so the frame is frozen while the learner draws their selection
    playerRef.current?.pauseVideo?.()

    setSelectionRect(null)
    setDragStart(null)
    setDragCurrent(null)
    setSnapPrompt('')
    setSnippetContext(null)
    setCaptureError(null)
    setIsCapturing(false)

    // If the player is in compact (sticky) mode, scroll back to top so it
    // expands to full size before the learner draws a selection.
    // The CSS transition is 380ms; we wait 420ms to be safe.
    if (isCompact && mainColumnRef.current) {
      mainColumnRef.current.scrollTo({ top: 0, behavior: 'smooth' })
      setTimeout(() => setMode('selection_mode'), 420)
      return
    }

    setMode('selection_mode')
  }

  const cancelSelection = () => {
    setSelectionRect(null)
    setDragStart(null)
    setDragCurrent(null)
    setSnapPrompt('')
    setSnippetContext(null)
    setCaptureError(null)
    setIsCapturing(false)
    setMode('default_viewing')
  }

  const submitSnippetQuestion = async () => {
    if (!selectionRect || !snippetContext || isCapturing) return

    const { timestampStr, transcriptSegment, region, stageW, stageH, timestampSeconds } = snippetContext
    const userText = snapPrompt.trim()

    // ── Step 1: screen-capture the exact selected region ──────────────────────
    setCaptureError(null)
    setIsCapturing(true)

    const imageDataUrl = await captureScreenRegion(selectionRect, playerStageRef.current)

    setIsCapturing(false)

    if (!imageDataUrl) {
      // User cancelled the browser share dialog — stay in confirm mode, allow retry
      setCaptureError('Screen access was cancelled. Click "Ask Pal" again to retry.')
      return
    }

    // ── Step 2: build the AI prompt ────────────────────────────────────────────
    // The image is sent separately as a vision attachment. The text prompt
    // provides timestamp + transcript context so the model can link what it
    // sees to where in the video the learner is.
    let aiPrompt = `I've selected a region of the video frame at timestamp ${timestampStr}.`

    if (transcriptSegment) {
      aiPrompt += ` The video is discussing:\n\n${transcriptSegment}\n\n`
    } else {
      aiPrompt += ' '
    }

    aiPrompt += userText
      ? `My question about the selected region: "${userText}"`
      : 'Please explain what is shown in this selected region.'

    // ── Step 3: assemble the snippet object for the chat card ──────────────────
    // imageDataUrl is the actual screen crop — shown in the chat thread and
    // sent to the AI. All fields are available for future backend integration.
    const snippet = {
      imageDataUrl,           // the real screen-captured crop
      timestampStr,
      timestampSeconds,
      region,
      stageW,
      stageH,
      transcriptSegment,
      userPrompt: userText,
    }

    // ── Step 4: clean up selection state and fire ──────────────────────────────
    setSelectionRect(null)
    setDragStart(null)
    setDragCurrent(null)
    setSnapPrompt('')
    setSnippetContext(null)
    setCaptureError(null)
    setMode('default_viewing')

    sendMessage(aiPrompt, snippet)
  }

  const pointerToBox = (event) => {
    const bounds = event.currentTarget.getBoundingClientRect()
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top }
  }

  const onSelectionStart = (event) => {
    if (mode !== 'selection_mode') return
    const box = pointerToBox(event)
    setDragStart(box)
    setDragCurrent(box)
  }

  const onSelectionMove = (event) => {
    if (mode !== 'selection_mode' || !dragStart) return
    setDragCurrent(pointerToBox(event))
  }

  const onSelectionEnd = () => {
    if (mode !== 'selection_mode' || !liveSelection) return
    if (liveSelection.width < 28 || liveSelection.height < 28) {
      setDragStart(null)
      setDragCurrent(null)
      return
    }

    const rect = { ...liveSelection }
    const stage = playerStageRef.current
    const stageW = stage?.offsetWidth ?? 0
    const stageH = stage?.offsetHeight ?? 0

    // Derive transcript segment around the current (paused) timestamp
    const WINDOW = 25
    const lo = currentPlaybackSeconds - WINDOW
    const hi = currentPlaybackSeconds + WINDOW
    const segment = transcriptRows.filter((r) => r.seconds >= lo && r.seconds <= hi)
    const mins = Math.floor(currentPlaybackSeconds / 60)
    const secs = Math.floor(currentPlaybackSeconds % 60)
    const timestampStr = `${mins}:${String(secs).padStart(2, '0')}`

    // Commit selection and immediately show the confirmation panel —
    // the real screen capture happens only when the user clicks Ask Pal.
    setSelectionRect(rect)
    setDragStart(null)
    setDragCurrent(null)
    setSnapPrompt('')
    setCaptureError(null)
    setSnippetContext({
      timestampSeconds: currentPlaybackSeconds,
      timestampStr,
      region: rect,
      stageW,
      stageH,
      transcriptSegment: segment.map((r) => `[${r.time}] ${r.text}`).join('\n'),
    })
    setMode('selection_confirm')
  }

  // ── Quiz handlers ─────────────────────────────────────────────────────────

  const fetchQuiz = async (prevQuestions) => {
    setQuizLoading(true)
    setQuizError(null)
    setCurrentQuiz(null)
    setSelectedOption(null)
    setMode('quiz_loading')
    try {
      const q = await generateQuizQuestion(aiProvider, currentPlaybackSeconds, prevQuestions)
      setCurrentQuiz(q)
      setAskedQuestions((prev) => [...prev, q.question])
      setMode('quiz_open')
    } catch (err) {
      setQuizError(err.message)
      setMode('quiz_loading')   // stay in modal to show error
    } finally {
      setQuizLoading(false)
    }
  }

  const openQuiz = () => fetchQuiz(askedQuestions)

  const submitQuiz = () => {
    if (selectedOption === null) return
    setMode('quiz_feedback')
  }

  const nextQuiz = () => fetchQuiz(askedQuestions)

  const closeQuiz = () => {
    setSelectedOption(null)
    setCurrentQuiz(null)
    setQuizError(null)
    setMode('default_viewing')
  }

  // ── Transcript ────────────────────────────────────────────────────────────

  const jumpToTranscriptTime = (row) => {
    setActiveTranscriptId(row.id)
    const player = playerRef.current
    if (player && typeof player.seekTo === 'function') {
      player.seekTo(row.seconds, true)
      if (typeof player.playVideo === 'function') player.playVideo()
      setCurrentPlaybackSeconds(row.seconds)
    }
  }

  const setTranscriptItemRef = (id, node) => {
    if (node) transcriptItemRefs.current.set(id, node)
    else transcriptItemRefs.current.delete(id)
  }

  // ── Selection actions popup position (clamped to stage) ──────────────────
  // The panel is ~180px wide × ~140px tall (input + 2 buttons + padding).
  // Prefer right of selection; fall back to left if it clips. Clamp vertically.

  const getActionsPos = () => {
    if (!selectionRect || !playerStageRef.current) return { left: 4, top: 4 }
    const stageW = playerStageRef.current.offsetWidth
    const stageH = playerStageRef.current.offsetHeight
    const W = 180
    const H = 142

    let left = selectionRect.left + selectionRect.width + 8
    if (left + W > stageW - 4) left = selectionRect.left - W - 8
    left = Math.max(4, Math.min(left, stageW - W - 4))

    let top = selectionRect.top + selectionRect.height + 8
    if (top + H > stageH - 4) top = selectionRect.top - H - 8
    top = Math.max(4, Math.min(top, stageH - H - 4))

    return { left, top }
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="lp-shell">
      <section className="lp-product-header">
        <div className="lp-brand">
          <img src={brandIcon} alt="LearnPal logo" />
          <h1>
            <span>Learn</span>Pal
          </h1>
        </div>
      </section>

      <main className="lp-app-layout">
        {/* Left nav */}
        <aside className="lp-left-nav">
          <button className="lp-icon-btn" type="button" aria-label="Menu">
            ☰
          </button>
          <div className="lp-left-bottom">
            <div className="lp-settings-anchor">
              <button
                ref={gearBtnRef}
                className={`lp-icon-btn${showSettings ? ' lp-icon-btn-active' : ''}`}
                type="button"
                aria-label="Settings"
                aria-expanded={showSettings}
                onClick={() => setShowSettings((v) => !v)}
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </button>

              {showSettings && (
                <div ref={settingsPanelRef} className="lp-settings-panel" role="dialog" aria-label="Settings">
                  <p className="lp-settings-label">Player controls</p>
                  <div className="lp-settings-seg">
                    <button
                      type="button"
                      className={`lp-seg-opt${playerControlsMode === 'custom' ? ' lp-seg-active' : ''}`}
                      onClick={() => switchPlayerControls('custom')}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                        <path d="M8 5v14l11-7z"/>
                      </svg>
                      Custom
                    </button>
                    <button
                      type="button"
                      className={`lp-seg-opt${playerControlsMode === 'native' ? ' lp-seg-active' : ''}`}
                      onClick={() => switchPlayerControls('native')}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                        <rect x="2" y="4" width="20" height="16" rx="2" stroke="currentColor" strokeWidth="1.8"/>
                        <path d="M8 10l2.5 2.5L8 15M12 15h4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                      YouTube
                    </button>
                  </div>
                </div>
              )}
            </div>

            <div className="lp-user-avatar" aria-label="User profile">
              P
            </div>
          </div>
        </aside>

        {/* Main content column */}
        <section className="lp-main-column" ref={mainColumnRef} onScroll={handleMainScroll}>
          {/* Video player */}
          <div className={`lp-player-wrap${isCompact ? ' lp-player-compact' : ''}`}>
            <div
              ref={playerStageRef}
              className={`lp-player-stage${playerControlsMode === 'custom' && !showControls ? ' lp-player-nocursor' : ''}`}
              onMouseMove={handleStageMouseMove}
              onMouseLeave={handleStageMouseLeave}
            >
              <div ref={playerHostRef} className="lp-youtube-player" />

              {/* Transparent click capture — only active in custom controls mode */}
              {!isSelectionFlow && playerControlsMode === 'custom' && (
                <div className="lp-player-click-capture" onClick={togglePlay} aria-hidden="true" />
              )}

              {/* ── Custom controls overlay ── */}
              {!isSelectionFlow && playerControlsMode === 'custom' && (
                <div className={`lp-controls${showControls ? ' lp-controls-visible' : ''}`}>

                  {/* Seek bar */}
                  <div
                    className="lp-seek-bar"
                    ref={progressRef}
                    onPointerDown={handleSeekPointerDown}
                    onPointerMove={handleSeekPointerMove}
                    onPointerUp={handleSeekPointerUp}
                  >
                    <div className="lp-seek-track">
                      <div className="lp-seek-fill" style={{ width: `${seekPercent}%` }} />
                      <div className="lp-seek-thumb" style={{ left: `${seekPercent}%` }} />
                    </div>
                  </div>

                  {/* Controls row */}
                  <div className="lp-controls-row">
                    <div className="lp-ctrl-left">

                      {/* Play / Pause */}
                      <button type="button" className="lp-ctrl-btn" onClick={togglePlay} aria-label={isPlaying ? 'Pause' : 'Play'}>
                        {isPlaying ? (
                          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                            <rect x="6" y="4" width="4" height="16" rx="1" /><rect x="14" y="4" width="4" height="16" rx="1" />
                          </svg>
                        ) : (
                          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                            <path d="M5 3l14 9-14 9V3z" />
                          </svg>
                        )}
                      </button>

                      {/* Rewind 10s */}
                      <button type="button" className="lp-ctrl-btn" onClick={() => seekRelative(-10)} aria-label="Rewind 10 seconds">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                          <path d="M11.99 5V1l-5 5 5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6h-2c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z" />
                          <text x="12" y="17" textAnchor="middle" fontSize="6" fontWeight="bold" fill="currentColor">10</text>
                        </svg>
                      </button>

                      {/* Forward 10s */}
                      <button type="button" className="lp-ctrl-btn" onClick={() => seekRelative(10)} aria-label="Forward 10 seconds">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                          <path d="M12.01 5V1l5 5-5 5V7c-3.31 0-6 2.69-6 6s2.69 6 6 6 6-2.69 6-6h2c0 4.42-3.58 8-8 8s-8-3.58-8-8 3.58-8 8-8z" />
                          <text x="12" y="17" textAnchor="middle" fontSize="6" fontWeight="bold" fill="currentColor">10</text>
                        </svg>
                      </button>

                      {/* Volume */}
                      <div className="lp-vol-group">
                        <button type="button" className="lp-ctrl-btn" onClick={toggleMute} aria-label={isMuted ? 'Unmute' : 'Mute'}>
                          {(isMuted || volume === 0) ? (
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                              <path d="M16.5 12A4.5 4.5 0 0 0 14 7.97v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.796 8.796 0 0 0 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06A8.99 8.99 0 0 0 17.73 18l1.73 1.73L21 18.46 5.73 3H4.27zM12 4L9.91 6.09 12 8.18V4z" />
                            </svg>
                          ) : volume < 50 ? (
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                              <path d="M18.5 12A4.5 4.5 0 0 0 16 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02zM5 9v6h4l5 5V4L9 9H5z" />
                            </svg>
                          ) : (
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                              <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />
                            </svg>
                          )}
                        </button>
                        <div className="lp-vol-track">
                          <input
                            type="range" min="0" max="100"
                            value={isMuted ? 0 : volume}
                            onChange={(e) => handleVolumeChange(Number(e.target.value))}
                            className="lp-vol-slider"
                            aria-label="Volume"
                          />
                        </div>
                      </div>

                      {/* Time display */}
                      <span className="lp-ctrl-time">{formatTime(currentPlaybackSeconds)} / {formatTime(duration)}</span>
                    </div>

                    <div className="lp-ctrl-right">

                      {/* Playback speed */}
                      <div className="lp-speed-group">
                        <button
                          type="button"
                          className="lp-ctrl-btn lp-speed-btn"
                          onClick={(e) => { e.stopPropagation(); setShowSpeedMenu((v) => !v) }}
                          aria-label="Playback speed"
                        >
                          {playbackRate === 1 ? '1×' : `${playbackRate}×`}
                        </button>
                        {showSpeedMenu && (
                          <div className="lp-speed-menu">
                            {[0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map((r) => (
                              <button
                                key={r}
                                type="button"
                                className={`lp-speed-opt${playbackRate === r ? ' lp-speed-current' : ''}`}
                                onClick={(e) => {
                                  e.stopPropagation()
                                  playerRef.current?.setPlaybackRate(r)
                                  setPlaybackRate(r)
                                  setShowSpeedMenu(false)
                                }}
                              >
                                {r === 1 ? 'Normal' : `${r}×`}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>

                      {/* Fullscreen */}
                      <button type="button" className="lp-ctrl-btn" onClick={toggleFullscreen} aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}>
                        {isFullscreen ? (
                          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                            <path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z" />
                          </svg>
                        ) : (
                          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                            <path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z" />
                          </svg>
                        )}
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* ── Snap-to-ask selection overlay ── */}
              {isSelectionFlow && (
                <div
                  className={`lp-selection-layer ${
                    mode === 'selection_mode' ? 'lp-selection-active' : 'lp-selection-still'
                  }`}
                  onMouseDown={onSelectionStart}
                  onMouseMove={onSelectionMove}
                  onMouseUp={onSelectionEnd}
                  role="presentation"
                >
                  <div className="lp-player-highlight" />

                  {mode === 'selection_mode' && (
                    <div className="lp-selection-hint">Drag to select an area, then ask Pal</div>
                  )}

                  {/* Live rubber-band box while dragging */}
                  {liveSelection && (
                    <div
                      className="lp-selection-box"
                      style={{
                        left: `${liveSelection.left}px`,
                        top: `${liveSelection.top}px`,
                        width: `${liveSelection.width}px`,
                        height: `${liveSelection.height}px`,
                      }}
                    />
                  )}

                  {/* Committed selection box + confirmation panel */}
                  {selectionRect && mode === 'selection_confirm' && (() => {
                    const pos = getActionsPos()
                    return (
                      <>
                        {/* The drawn box — non-interactive once confirmed */}
                        <div
                          className="lp-selection-box lp-selection-box-confirmed"
                          style={{
                            left: `${selectionRect.left}px`,
                            top: `${selectionRect.top}px`,
                            width: `${selectionRect.width}px`,
                            height: `${selectionRect.height}px`,
                          }}
                        />

                        {/* Confirmation panel: optional prompt + Ask Pal / Cancel */}
                        <div
                          className="lp-selection-actions"
                          style={{ left: `${pos.left}px`, top: `${pos.top}px` }}
                          onMouseDown={(e) => e.stopPropagation()}
                        >
                          {isCapturing ? (
                            // Waiting for the browser screen-share permission dialog
                            <div className="lp-capture-status">
                              <div className="lp-typing-indicator lp-capture-dots">
                                <span /><span /><span />
                              </div>
                              <p>Grant screen access in the browser dialog…</p>
                            </div>
                          ) : (
                            <>
                              <input
                                className="lp-snap-prompt-input"
                                type="text"
                                placeholder="Ask about this… (optional)"
                                value={snapPrompt}
                                onChange={(e) => setSnapPrompt(e.target.value)}
                                onKeyDown={(e) => { if (e.key === 'Enter') submitSnippetQuestion() }}
                                // eslint-disable-next-line jsx-a11y/no-autofocus
                                autoFocus
                              />
                              {captureError && (
                                <p className="lp-capture-hint">{captureError}</p>
                              )}
                              <button type="button" onClick={submitSnippetQuestion}>
                                Ask Pal
                              </button>
                              <button type="button" className="lp-secondary" onClick={cancelSelection}>
                                Cancel
                              </button>
                            </>
                          )}
                        </div>
                      </>
                    )
                  })()}
                </div>
              )}
            </div>
          </div>

          {/* Feature cards */}
          <div className="lp-feature-row">
            <article className="lp-feature-card">
              <div className="lp-feature-head">
                <div className="lp-feature-head-left">
                  {/* Snap / screenshot icon */}
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" stroke="#0336ff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                    <circle cx="12" cy="13" r="4" stroke="#0336ff" strokeWidth="1.8"/>
                  </svg>
                  <h3>Snap to ask Pal</h3>
                </div>
                <button
                  type="button"
                  onClick={startSelection}
                  className={isSelectionFlow ? 'lp-disabled-btn' : ''}
                  disabled={isSelectionFlow}
                >
                  Select Area
                </button>
              </div>
              <p className="lp-tip">ⓘ Take a snippet from the video to understand concepts better</p>
            </article>

            <article className="lp-feature-card">
              <div className="lp-feature-head">
                <div className="lp-feature-head-left">
                  {/* Quiz / lightbulb icon */}
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path d="M9 18h6M10 22h4M12 2a7 7 0 0 1 7 7c0 2.387-1.21 4.49-3.05 5.74L15 16H9l-.95-1.26C6.21 13.49 5 11.387 5 9a7 7 0 0 1 7-7z" stroke="#0336ff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                  <h3>Quiz me now</h3>
                </div>
                <button type="button" onClick={openQuiz}>
                  Start Quiz
                </button>
              </div>
              <p className="lp-tip">ⓘ Pause and test your understanding before you move ahead.</p>
            </article>
          </div>

          {/* Transcript */}
          <section className="lp-transcripts">
            <div className="lp-transcripts-header" ref={transcriptsHeaderRef}>
              <h3>Transcripts</h3>
              <div className="lp-divider" />
            </div>
            <div className="lp-transcript-list" ref={transcriptListRef} onScroll={handleTranscriptScroll}>
              {transcriptRows.map((row) => (
                <button
                  type="button"
                  className={`lp-transcript-row ${activeTranscriptId === row.id ? 'lp-active-row' : ''}`}
                  key={row.id}
                  onClick={() => jumpToTranscriptTime(row)}
                  ref={(node) => setTranscriptItemRef(row.id, node)}
                >
                  <span className="lp-transcript-time">{row.time}</span>
                  <p className="lp-transcript-text">{row.text}</p>
                </button>
              ))}
            </div>
          </section>
        </section>

        {/* Chat sidebar */}
        <aside className="lp-chat-column">
          <div className="lp-chat-title">
            Ask Pal
            <button
              type="button"
              className="lp-provider-toggle"
              onClick={() =>
                setAiProvider((p) => {
                  const idx = PROVIDER_CYCLE.indexOf(p)
                  return PROVIDER_CYCLE[(idx + 1) % PROVIDER_CYCLE.length]
                })
              }
              title="Switch AI provider"
            >
              {PROVIDER_LABELS[aiProvider]}
            </button>
          </div>

          <section className="lp-chat-hero" ref={chatMessagesRef}>
            {messages.length === 0 && !isLoading ? (
              <div className="lp-greeting-wrap">
                <img src={palCharacter} alt="Pal mascot" />
                <div className="lp-greeting-bubbles">
                  <p className="lp-greet-light">Hi there,</p>
                  <p className="lp-greet-strong">How can I help you?</p>
                </div>
              </div>
            ) : (
              <div className="lp-snap-chat-flow">
                {messages.map((msg, i) =>
                  msg.role === 'user' ? (
                    <div key={i} className="lp-flow-user-end lp-flow-col">
                      {msg.isSnippet && msg.snippet ? (
                        // Snippet card — visual frame capture + timestamp + optional user question
                        <div className="lp-flow-chip lp-flow-snippet">
                          <div className="lp-snippet-thumb">
                            {msg.snippet.imageDataUrl ? (
                              <img
                                src={msg.snippet.imageDataUrl}
                                alt={`Video frame at ${msg.snippet.timestampStr}`}
                                draggable={false}
                              />
                            ) : (
                              <div className="lp-video-placeholder">
                                <span aria-hidden="true">▶</span>
                              </div>
                            )}
                            <span className="lp-snippet-timestamp">
                              &#9654; {msg.snippet.timestampStr}
                            </span>
                          </div>
                          {msg.snippet.userPrompt && (
                            <p className="lp-snippet-user-prompt">{msg.snippet.userPrompt}</p>
                          )}
                        </div>
                      ) : (
                        // Regular chat message
                        <div className="lp-flow-chip">{msg.content}</div>
                      )}
                    </div>
                  ) : (
                    <div key={i} className="lp-flow-assistant">
                      <p>{msg.content}</p>
                    </div>
                  )
                )}

                {isLoading && (
                  <div className="lp-flow-assistant">
                    <div className="lp-typing-indicator">
                      <span />
                      <span />
                      <span />
                    </div>
                  </div>
                )}

                {aiError && (
                  <div className="lp-flow-assistant">
                    <p className="lp-error-msg">⚠ {aiError}</p>
                  </div>
                )}
              </div>
            )}
          </section>

          <section className="lp-chat-bottom">
            <div className="lp-input-row">
              <form
                className="lp-input-main"
                onSubmit={(e) => {
                  e.preventDefault()
                  sendMessage(chatInput)
                }}
              >
                <input
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  placeholder="Ask me anything..."
                  aria-label="Ask Pal input"
                  disabled={isLoading}
                />
                <button type="submit" aria-label="Send message" disabled={isLoading}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path d="M22 2L11 13M22 2L15 22l-4-9-9-4 20-7z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </button>
              </form>
            </div>

            {messages.length === 0 && (
              <div className="lp-suggestions-wrap">
                <h4>Quick suggestions</h4>
                {quickSuggestions.map((s) => (
                  <button
                    key={s}
                    type="button"
                    className="lp-suggestion-chip"
                    onClick={() => sendMessage(s)}
                    disabled={isLoading}
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}
          </section>

          <p className="lp-ai-disclaimer">
            Pal can make mistakes. Always verify important information.
          </p>
        </aside>
      </main>

      {/* Quiz modal */}
      {isQuizOpen && (
        <div className="lp-modal-backdrop" role="presentation" onClick={closeQuiz}>
          <section
            className="lp-quiz-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Quick quiz"
            onClick={(e) => e.stopPropagation()}
          >
            <h3>Quiz me now</h3>
            <p className="lp-quiz-meta">Generated from what you have watched so far.</p>

            {/* Loading state */}
            {quizLoading && (
              <div className="lp-quiz-loading">
                <div className="lp-typing-indicator">
                  <span /><span /><span />
                </div>
                <p>Generating a question…</p>
              </div>
            )}

            {/* Error state */}
            {quizError && !quizLoading && (
              <div className="lp-quiz-feedback">
                <p className="lp-error-msg">⚠ {quizError}</p>
              </div>
            )}

            {/* Question */}
            {currentQuiz && !quizLoading && (
              <>
                <p className="lp-quiz-question">{currentQuiz.question}</p>

                <div className="lp-quiz-options">
                  {currentQuiz.options.map((option, index) => {
                    const isSelected = selectedOption === index
                    const isCorrect = mode === 'quiz_feedback' && index === currentQuiz.correctIndex
                    const isWrongSelected =
                      mode === 'quiz_feedback' && isSelected && index !== currentQuiz.correctIndex
                    return (
                      <button
                        key={option}
                        type="button"
                        className={`lp-quiz-option${isSelected ? ' lp-selected' : ''}${isCorrect ? ' lp-correct' : ''}${isWrongSelected ? ' lp-wrong' : ''}`}
                        onClick={() => mode === 'quiz_open' && setSelectedOption(index)}
                      >
                        {option}
                      </button>
                    )
                  })}
                </div>

                {mode === 'quiz_feedback' && (
                  <div className="lp-quiz-feedback">
                    <p>
                      {selectedOption === currentQuiz.correctIndex ? 'Correct. Nice work.' : 'Not quite. Keep going.'}
                    </p>
                    <p>{currentQuiz.explanation}</p>
                  </div>
                )}
              </>
            )}

            <div className="lp-quiz-actions">
              {mode === 'quiz_open' && (
                <button type="button" onClick={submitQuiz} disabled={selectedOption === null}>
                  Submit Answer
                </button>
              )}
              {mode === 'quiz_feedback' && (
                <button type="button" onClick={nextQuiz}>
                  Ask one more
                </button>
              )}
              <button type="button" className="lp-secondary" onClick={closeQuiz}>
                Back to video
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  )
}

export default App
