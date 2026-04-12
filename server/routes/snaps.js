import { Router } from 'express'
import db from '../db.js'

const router = Router()

// Save a snap (image + metadata + AI response)
router.post('/', (req, res) => {
  const {
    sessionId, imageData, timestampSeconds, timestampStr,
    region, userPrompt, aiResponse, provider,
  } = req.body

  if (!sessionId) {
    return res.status(400).json({ error: 'sessionId is required' })
  }

  const result = db.prepare(`
    INSERT INTO snaps
      (session_id, image_data, timestamp_seconds, timestamp_str, region, user_prompt, ai_response, provider)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sessionId,
    imageData ?? null,
    timestampSeconds ?? null,
    timestampStr ?? null,
    region ? JSON.stringify(region) : null,
    userPrompt ?? null,
    aiResponse ?? null,
    provider ?? null,
  )

  res.json({ id: result.lastInsertRowid })
})

// Get all snaps for a session (without image data to keep response small)
router.get('/:sessionId', (req, res) => {
  const snaps = db.prepare(`
    SELECT id, session_id, timestamp_seconds, timestamp_str,
           region, user_prompt, ai_response, provider, created_at
    FROM snaps WHERE session_id = ? ORDER BY created_at ASC
  `).all(req.params.sessionId)

  res.json(snaps.map((s) => ({ ...s, region: s.region ? JSON.parse(s.region) : null })))
})

// Get a single snap including its image
router.get('/:sessionId/:snapId', (req, res) => {
  const snap = db.prepare(
    'SELECT * FROM snaps WHERE id = ? AND session_id = ?'
  ).get(req.params.snapId, req.params.sessionId)

  if (!snap) return res.status(404).json({ error: 'Snap not found' })

  res.json({ ...snap, region: snap.region ? JSON.parse(snap.region) : null })
})

export default router
