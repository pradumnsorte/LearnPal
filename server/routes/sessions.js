import { Router } from 'express'
import db from '../db.js'

const router = Router()

// Create a new session
router.post('/', (req, res) => {
  const { videoId, videoTitle } = req.body
  if (!videoId || !videoTitle) {
    return res.status(400).json({ error: 'videoId and videoTitle are required' })
  }
  const result = db.prepare(
    'INSERT INTO sessions (video_id, video_title) VALUES (?, ?)'
  ).run(videoId, videoTitle)

  res.json({ id: result.lastInsertRowid, videoId, videoTitle })
})

// List recent sessions (last 20)
router.get('/', (req, res) => {
  const sessions = db.prepare(
    'SELECT * FROM sessions ORDER BY created_at DESC LIMIT 20'
  ).all()
  res.json(sessions)
})

// Update participant ID for a session
router.patch('/:id', (req, res) => {
  const { participantId } = req.body
  db.prepare('UPDATE sessions SET participant_id = ? WHERE id = ?')
    .run(participantId ?? null, req.params.id)
  res.json({ ok: true })
})

// Get a single session with all its data
router.get('/:id', (req, res) => {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.id)
  if (!session) return res.status(404).json({ error: 'Session not found' })

  const messages = db.prepare(
    'SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC'
  ).all(session.id)

  const snaps = db.prepare(
    'SELECT id, session_id, timestamp_seconds, timestamp_str, region, user_prompt, ai_response, provider, created_at FROM snaps WHERE session_id = ? ORDER BY created_at ASC'
  ).all(session.id)

  const quizAttempts = db.prepare(
    'SELECT * FROM quiz_attempts WHERE session_id = ? ORDER BY created_at ASC'
  ).all(session.id)

  res.json({ ...session, messages, snaps, quizAttempts })
})

export default router
