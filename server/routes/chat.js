import { Router } from 'express'
import db from '../db.js'

const router = Router()

// ── Provider dispatch ─────────────────────────────────────────────────────────

const callProvider = async (provider, messages, systemPrompt, imageDataUrl = null) => {
  const base64 = imageDataUrl ? imageDataUrl.replace(/^data:image\/\w+;base64,/, '') : null

  if (provider === 'groq') {
    const groqMessages = messages.map(({ role, content }) => ({ role, content }))
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 512,
        messages: [{ role: 'system', content: systemPrompt }, ...groqMessages],
      }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err?.error?.message ?? `Groq error ${res.status}`)
    }
    const data = await res.json()
    return data.choices[0].message.content
  }

  if (provider === 'ollama') {
    const ollamaModel = process.env.OLLAMA_MODEL || 'llama3.2'
    const ollamaMessages = messages.map(({ role, content }, i) => {
      const isLastUser = role === 'user' && i === messages.length - 1
      if (base64 && isLastUser) {
        return {
          role,
          content: [
            { type: 'image_url', image_url: { url: imageDataUrl } },
            { type: 'text', text: content },
          ],
        }
      }
      return { role, content }
    })
    const res = await fetch('http://localhost:11434/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: ollamaModel,
        max_tokens: 512,
        messages: [{ role: 'system', content: systemPrompt }, ...ollamaMessages],
      }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err?.error?.message ?? `Ollama error ${res.status} — is Ollama running?`)
    }
    const data = await res.json()
    return data.choices[0].message.content
  }

  if (provider === 'claude') {
    const apiMessages = messages.map(({ role, content }, i) => {
      const isLastUser = role === 'user' && i === messages.length - 1
      if (base64 && isLastUser) {
        return {
          role,
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64 } },
            { type: 'text', text: content },
          ],
        }
      }
      return { role, content }
    })
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 512,
        system: systemPrompt,
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

  if (provider === 'azure') {
    const endpoint = process.env.AZURE_OPENAI_ENDPOINT?.replace(/\/$/, '')
    const deployment = process.env.AZURE_OPENAI_DEPLOYMENT
    const apiVersion = process.env.AZURE_OPENAI_API_VERSION || '2024-02-01'
    const url = `${endpoint}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`
    const apiMessages = messages.map(({ role, content }, i) => {
      const isLastUser = role === 'user' && i === messages.length - 1
      if (imageDataUrl && isLastUser) {
        return {
          role,
          content: [
            { type: 'image_url', image_url: { url: imageDataUrl } },
            { type: 'text', text: content },
          ],
        }
      }
      return { role, content }
    })
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': process.env.AZURE_OPENAI_API_KEY,
      },
      body: JSON.stringify({
        max_tokens: 512,
        messages: [{ role: 'system', content: systemPrompt }, ...apiMessages],
      }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err?.error?.message ?? `Azure OpenAI error ${res.status}`)
    }
    const data = await res.json()
    return data.choices[0].message.content
  }

  if (provider === 'openai') {
    const apiMessages = messages.map(({ role, content }, i) => {
      const isLastUser = role === 'user' && i === messages.length - 1
      if (imageDataUrl && isLastUser) {
        return {
          role,
          content: [
            { type: 'image_url', image_url: { url: imageDataUrl } },
            { type: 'text', text: content },
          ],
        }
      }
      return { role, content }
    })
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        max_tokens: 512,
        messages: [{ role: 'system', content: systemPrompt }, ...apiMessages],
      }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err?.error?.message ?? `OpenAI error ${res.status}`)
    }
    const data = await res.json()
    return data.choices[0].message.content
  }

  throw new Error('Unknown provider')
}

// ── Route ─────────────────────────────────────────────────────────────────────

router.post('/', async (req, res) => {
  const { sessionId, provider, messages, systemPrompt, imageDataUrl } = req.body

  if (!provider || !messages || !systemPrompt) {
    return res.status(400).json({ error: 'provider, messages, and systemPrompt are required' })
  }

  try {
    const reply = await callProvider(provider, messages, systemPrompt, imageDataUrl)

    // Save to database if a session is active
    if (sessionId) {
      const lastUserMessage = [...messages].reverse().find((m) => m.role === 'user')
      if (lastUserMessage) {
        db.prepare(
          'INSERT INTO messages (session_id, role, content, provider) VALUES (?, ?, ?, ?)'
        ).run(sessionId, 'user', lastUserMessage.content, provider)
      }
      db.prepare(
        'INSERT INTO messages (session_id, role, content, provider) VALUES (?, ?, ?, ?)'
      ).run(sessionId, 'assistant', reply, provider)
    }

    res.json({ reply })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

export default router
