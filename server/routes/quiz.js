import { Router } from 'express'
import db from '../db.js'
import { jsonrepair } from 'jsonrepair'

const router = Router()

// Robustly extract and parse the first JSON object from a model response.
// 1. Slices from the first '{' to the last '}' to strip surrounding text/fences
// 2. Tries standard JSON.parse first (fast path)
// 3. Falls back to jsonrepair which fixes trailing commas, missing quotes, etc.
const extractJSON = (raw) => {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start === -1 || end === -1) throw new Error('No JSON object found in model response')
  const slice = raw.slice(start, end + 1)
  try {
    return JSON.parse(slice)
  } catch {
    return JSON.parse(jsonrepair(slice))
  }
}

// ── Provider dispatch ─────────────────────────────────────────────────────────

const callQuizProvider = async (provider, prompt) => {
  if (provider === 'groq') {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 1024,
        response_format: { type: 'json_object' },
        messages: [{ role: 'user', content: prompt }],
      }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err?.error?.message ?? `Groq error ${res.status}`)
    }
    const data = await res.json()
    return extractJSON(data.choices[0].message.content)
  }

  if (provider === 'ollama') {
    const ollamaModel = process.env.OLLAMA_MODEL || 'llama3.2'
    const res = await fetch('http://localhost:11434/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: ollamaModel,
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }],
      }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err?.error?.message ?? `Ollama error ${res.status} — is Ollama running?`)
    }
    const data = await res.json()
    return extractJSON(data.choices[0].message.content)
  }

  if (provider === 'claude') {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }],
      }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err?.error?.message ?? `Claude error ${res.status}`)
    }
    const data = await res.json()
    return extractJSON(data.content[0].text)
  }

  if (provider === 'openai') {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        max_tokens: 1024,
        response_format: { type: 'json_object' },
        messages: [{ role: 'user', content: prompt }],
      }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err?.error?.message ?? `OpenAI error ${res.status}`)
    }
    const data = await res.json()
    return extractJSON(data.choices[0].message.content)
  }

  throw new Error('Unknown provider')
}

// ── Generate a question ───────────────────────────────────────────────────────

router.post('/generate', async (req, res) => {
  const { provider, prompt } = req.body

  if (!provider || !prompt) {
    return res.status(400).json({ error: 'provider and prompt are required' })
  }

  try {
    const question = await callQuizProvider(provider, prompt)
    res.json(question)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── Save a completed attempt ──────────────────────────────────────────────────

router.post('/submit', (req, res) => {
  const { sessionId, question, options, correctIndex, selectedIndex, isCorrect, difficulty, provider } = req.body

  if (!sessionId || !question) {
    return res.status(400).json({ error: 'sessionId and question are required' })
  }

  const result = db.prepare(`
    INSERT INTO quiz_attempts
      (session_id, question, options, correct_index, selected_index, is_correct, difficulty, provider)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sessionId,
    question,
    JSON.stringify(options),
    correctIndex,
    selectedIndex ?? null,
    isCorrect ? 1 : 0,
    difficulty ?? 1,
    provider ?? null,
  )

  res.json({ id: result.lastInsertRowid })
})

// ── Get quiz history for a session ───────────────────────────────────────────

router.get('/:sessionId', (req, res) => {
  const attempts = db.prepare(
    'SELECT * FROM quiz_attempts WHERE session_id = ? ORDER BY created_at ASC'
  ).all(req.params.sessionId)

  res.json(attempts.map((a) => ({ ...a, options: JSON.parse(a.options) })))
})

export default router
