import { Router } from 'express'
import db from '../db.js'

const router = Router()

// Log a behaviour event
router.post('/', (req, res) => {
  const { sessionId, eventType, playbackSeconds, meta } = req.body

  if (!sessionId || !eventType) {
    return res.status(400).json({ error: 'sessionId and eventType are required' })
  }

  const metaStr = meta == null ? null : (typeof meta === 'string' ? meta : JSON.stringify(meta))

  const result = db.prepare(
    'INSERT INTO events (session_id, event_type, playback_seconds, meta) VALUES (?, ?, ?, ?)'
  ).run(sessionId, eventType, playbackSeconds ?? null, metaStr)

  res.json({ id: result.lastInsertRowid })
})

// Get all events for a session
router.get('/:sessionId', (req, res) => {
  const events = db.prepare(
    'SELECT * FROM events WHERE session_id = ? ORDER BY created_at ASC'
  ).all(req.params.sessionId)
  res.json(events)
})

export default router
