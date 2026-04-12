import { Router } from 'express'
import db from '../db.js'

const router = Router()

router.get('/', (req, res) => {
  const sessions = db.prepare('SELECT * FROM sessions ORDER BY created_at ASC').all()

  const rows = sessions.map((s) => {
    const messageCount = db.prepare(
      'SELECT COUNT(*) as c FROM messages WHERE session_id = ?'
    ).get(s.id).c

    const quizTotal = db.prepare(
      'SELECT COUNT(*) as c FROM quiz_attempts WHERE session_id = ?'
    ).get(s.id).c

    const quizCorrect = db.prepare(
      'SELECT COUNT(*) as c FROM quiz_attempts WHERE session_id = ? AND is_correct = 1'
    ).get(s.id).c

    const snapCount = db.prepare(
      'SELECT COUNT(*) as c FROM snaps WHERE session_id = ?'
    ).get(s.id).c

    const firstInteraction = db.prepare(
      'SELECT created_at FROM events WHERE session_id = ? AND event_type = ? LIMIT 1'
    ).get(s.id, 'first_interaction')

    const sessionEnd = db.prepare(
      'SELECT playback_seconds FROM events WHERE session_id = ? AND event_type = ? ORDER BY created_at DESC LIMIT 1'
    ).get(s.id, 'session_end')

    // Total session duration in seconds
    const endEvent = db.prepare(
      'SELECT created_at FROM events WHERE session_id = ? AND event_type = ? ORDER BY created_at DESC LIMIT 1'
    ).get(s.id, 'session_end')

    const durationSeconds = endEvent
      ? Math.round((new Date(endEvent.created_at) - new Date(s.created_at)) / 1000)
      : null

    // Time to first interaction in seconds
    const timeToFirstInteraction = firstInteraction
      ? Math.round((new Date(firstInteraction.created_at) - new Date(s.created_at)) / 1000)
      : null

    return {
      session_id: s.id,
      participant_id: s.participant_id ?? '',
      created_at: s.created_at,
      duration_seconds: durationSeconds ?? '',
      final_video_position: sessionEnd?.playback_seconds ?? '',
      messages_sent: messageCount,
      snaps_taken: snapCount,
      quiz_attempts: quizTotal,
      quiz_correct: quizCorrect,
      time_to_first_interaction_seconds: timeToFirstInteraction ?? '',
    }
  })

  const headers = Object.keys(rows[0] ?? {
    session_id: '', participant_id: '', created_at: '', duration_seconds: '',
    final_video_position: '', messages_sent: '', snaps_taken: '',
    quiz_attempts: '', quiz_correct: '', time_to_first_interaction_seconds: '',
  })

  const csv = [
    headers.join(','),
    ...rows.map((r) => headers.map((h) => JSON.stringify(r[h] ?? '')).join(',')),
  ].join('\n')

  res.setHeader('Content-Type', 'text/csv')
  res.setHeader('Content-Disposition', 'attachment; filename="learnpal-sessions.csv"')
  res.send(csv)
})

export default router
