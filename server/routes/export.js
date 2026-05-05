import { Router } from 'express'
import * as XLSX from 'xlsx'
import db from '../db.js'

const router = Router()

const PARADIGM = 'intermittent'
const ALIAS = {
  quiz_skipped:     ['quiz_skipped'],
  quiz_explained:   ['quiz_explained'],
  quiz_reviewed:    ['quiz_review_opened'],
  paradigm_feature: ['snap_started', 'snap_cancelled'],
  ai_shown:     ['quiz_started'],
  ai_accepted:  ['quiz_correct', 'quiz_wrong', 'snap_completed'],
  ai_rejected:  ['quiz_skipped'],
  icap_active:        ['video_pause', 'video_seek', 'transcript_clicked'],
  icap_constructive:  ['chat_message_sent', 'snap_completed', 'quiz_correct', 'quiz_wrong', 'chat_suggestion_clicked'],
  icap_interactive:   [],
}

const VIDEO_DURATION_SECONDS = 1080

const toCsv = (rows, headers) => {
  if (rows.length === 0) return headers.join(',')
  return [
    headers.join(','),
    ...rows.map((r) => headers.map((h) => JSON.stringify(r[h] ?? '')).join(',')),
  ].join('\n')
}

const sendCsv = (res, filename, csv) => {
  res.setHeader('Content-Type', 'text/csv')
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
  res.send(csv)
}

const buildComparableRows = () => {
  const sessions = db.prepare('SELECT * FROM sessions ORDER BY created_at ASC').all()

  const sumPairedDeltas = (events, openType, closeTypes) => {
    let total = 0
    for (let i = 0; i < events.length; i += 1) {
      if (events[i].event_type !== openType) continue
      for (let j = i + 1; j < events.length; j += 1) {
        if (closeTypes.includes(events[j].event_type)) {
          const dt = (new Date(events[j].created_at) - new Date(events[i].created_at)) / 1000
          if (dt > 0) total += dt
          break
        }
      }
    }
    return total
  }

  return sessions.map((s) => {
    const events = db.prepare(
      'SELECT event_type, playback_seconds, meta, created_at FROM events WHERE session_id = ? ORDER BY created_at ASC'
    ).all(s.id)

    const attempts = db.prepare(
      'SELECT is_correct, difficulty, time_to_answer_seconds FROM quiz_attempts WHERE session_id = ?'
    ).all(s.id)

    const messagesSent = db.prepare(
      "SELECT COUNT(*) AS c FROM messages WHERE session_id = ? AND role = 'user'"
    ).get(s.id).c

    const snapsTaken = db.prepare(
      'SELECT COUNT(*) AS c FROM snaps WHERE session_id = ?'
    ).get(s.id).c

    const lastEvent = events[events.length - 1]
    const sessionEndEvent = [...events].reverse().find((e) => e.event_type === 'session_end')
    const firstInteraction = events.find((e) => e.event_type === 'first_interaction')

    const sessionDurationSeconds = lastEvent
      ? Math.round((new Date(lastEvent.created_at) - new Date(s.created_at)) / 1000)
      : null

    const finalVideoPosition = sessionEndEvent?.playback_seconds ?? null

    const timeToFirstInteractionSeconds = firstInteraction
      ? Math.round((new Date(firstInteraction.created_at) - new Date(s.created_at)) / 1000)
      : null

    const activeVideoSeconds = Math.round(
      sumPairedDeltas(events, 'video_play', ['video_pause', 'video_ended', 'session_end'])
    )

    const countByType = (types) => events.filter((e) => types.includes(e.event_type)).length

    const seekEvents = events.filter((e) => e.event_type === 'video_seek')

    const total = attempts.length
    const correct = attempts.filter((a) => a.is_correct === 1).length
    const accuracyPct = total > 0 ? Math.round((correct / total) * 1000) / 10 : null

    const timeMean = (arr) => {
      const valid = arr.map((a) => a.time_to_answer_seconds).filter((v) => v != null)
      if (valid.length === 0) return null
      return Math.round((valid.reduce((a, b) => a + b, 0) / valid.length) * 100) / 100
    }
    const avgTimeAll  = timeMean(attempts)
    const highestDiff = attempts.reduce((m, a) => Math.max(m, a.difficulty ?? 0), 0) || null

    return {
      participant_id: s.participant_id ?? '',
      paradigm: s.paradigm ?? PARADIGM,
      started_at: s.created_at,

      session_duration_seconds: sessionDurationSeconds ?? '',
      active_video_seconds: activeVideoSeconds,
      final_video_position_seconds: finalVideoPosition ?? '',
      video_completion_pct: finalVideoPosition != null
        ? Math.min(100, Math.round((finalVideoPosition / VIDEO_DURATION_SECONDS) * 1000) / 10)
        : '',
      time_to_first_interaction_seconds: timeToFirstInteractionSeconds ?? '',

      chat_messages_sent: messagesSent,
      transcript_clicks: countByType(['transcript_clicked']),
      video_pauses: countByType(['video_pause']),
      video_seeks_total: seekEvents.length,
      playback_speed_changes: countByType(['playback_speed_changed']),

      quiz_attempts_total: total,
      quiz_correct: correct,
      quiz_accuracy_pct: accuracyPct ?? '',
      quiz_skipped_total: countByType(ALIAS.quiz_skipped),
      avg_time_to_answer_seconds: avgTimeAll ?? '',
      highest_difficulty_reached: highestDiff ?? '',
      quiz_explanations_requested: countByType(ALIAS.quiz_explained),
      quiz_reviewed_count: countByType(ALIAS.quiz_reviewed),

      snaps_taken: snapsTaken,
      paradigm_feature_engagements: countByType(ALIAS.paradigm_feature),

      ai_suggestions_shown:    countByType(ALIAS.ai_shown),
      ai_suggestions_accepted: countByType(ALIAS.ai_accepted),
      ai_suggestions_rejected: countByType(ALIAS.ai_rejected),
      ai_acceptance_rate_pct: (() => {
        const shown = countByType(ALIAS.ai_shown)
        const acc   = countByType(ALIAS.ai_accepted)
        return shown > 0 ? Math.round((acc / shown) * 1000) / 10 : ''
      })(),

      icap_active_events:       countByType(ALIAS.icap_active),
      icap_constructive_events: countByType(ALIAS.icap_constructive),
      icap_interactive_events:  countByType(ALIAS.icap_interactive),
    }
  })
}

router.get('/', (req, res) => {
  const rows = buildComparableRows()
  const headers = rows[0] ? Object.keys(rows[0]) : ['participant_id']
  sendCsv(res, 'learnpal-sessions.csv', toCsv(rows, headers))
})

router.get('/messages', (req, res) => {
  const rows = db.prepare(`
    SELECT s.participant_id, s.paradigm, m.role, m.provider, m.source, m.created_at
    FROM messages m JOIN sessions s ON s.id = m.session_id
    ORDER BY m.session_id ASC, m.created_at ASC
  `).all()
  const headers = ['participant_id', 'paradigm', 'role', 'provider', 'source', 'created_at']
  sendCsv(res, 'learnpal-messages.csv', toCsv(rows, headers))
})

router.get('/quizzes', (req, res) => {
  const rows = db.prepare(`
    SELECT s.participant_id, s.paradigm, q.question, q.correct_index,
           q.selected_index, q.is_correct, q.difficulty, q.provider,
           q.time_to_answer_seconds, q.created_at
    FROM quiz_attempts q JOIN sessions s ON s.id = q.session_id
    ORDER BY q.session_id ASC, q.created_at ASC
  `).all()
  const headers = ['participant_id', 'paradigm', 'question', 'correct_index',
                   'selected_index', 'is_correct', 'difficulty', 'provider',
                   'time_to_answer_seconds', 'created_at']
  sendCsv(res, 'learnpal-quizzes.csv', toCsv(rows, headers))
})

router.get('/snaps', (req, res) => {
  const rows = db.prepare(`
    SELECT s.participant_id, s.paradigm, n.timestamp_seconds, n.timestamp_str,
           n.region, n.user_prompt, n.provider, n.created_at
    FROM snaps n JOIN sessions s ON s.id = n.session_id
    ORDER BY n.session_id ASC, n.created_at ASC
  `).all()
  const headers = ['participant_id', 'paradigm', 'timestamp_seconds', 'timestamp_str',
                   'region', 'user_prompt', 'provider', 'created_at']
  sendCsv(res, 'learnpal-snaps.csv', toCsv(rows, headers))
})

router.get('/events', (req, res) => {
  const rows = db.prepare(`
    SELECT s.participant_id, s.paradigm, e.session_id, e.event_type, e.playback_seconds, e.meta, e.created_at
    FROM events e JOIN sessions s ON s.id = e.session_id
    ORDER BY e.session_id ASC, e.created_at ASC
  `).all()
  const headers = ['participant_id', 'paradigm', 'session_id', 'event_type', 'playback_seconds', 'meta', 'created_at']
  sendCsv(res, 'learnpal-events.csv', toCsv(rows, headers))
})

router.get('/comparable', (req, res) => {
  const rows = buildComparableRows()
  const headers = rows[0] ? Object.keys(rows[0]) : ['participant_id']
  sendCsv(res, 'learnpal-comparable.csv', toCsv(rows, headers))
})

router.get('/all', (req, res) => {
  const comparable = buildComparableRows()

  const messages = db.prepare(`
    SELECT s.participant_id, s.paradigm, m.role, m.provider, m.source, m.created_at
    FROM messages m JOIN sessions s ON s.id = m.session_id
    ORDER BY m.session_id ASC, m.created_at ASC
  `).all()

  const quizzes = db.prepare(`
    SELECT s.participant_id, s.paradigm, q.question, q.correct_index,
           q.selected_index, q.is_correct, q.difficulty, q.provider,
           q.time_to_answer_seconds, q.created_at
    FROM quiz_attempts q JOIN sessions s ON s.id = q.session_id
    ORDER BY q.session_id ASC, q.created_at ASC
  `).all()

  const snaps = db.prepare(`
    SELECT s.participant_id, s.paradigm, n.timestamp_seconds, n.timestamp_str,
           n.region, n.user_prompt, n.provider, n.created_at
    FROM snaps n JOIN sessions s ON s.id = n.session_id
    ORDER BY n.session_id ASC, n.created_at ASC
  `).all()

  const events = db.prepare(`
    SELECT s.participant_id, s.paradigm, e.session_id, e.event_type, e.playback_seconds, e.meta, e.created_at
    FROM events e JOIN sessions s ON s.id = e.session_id
    ORDER BY e.session_id ASC, e.created_at ASC
  `).all()

  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(comparable), 'Comparable')
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(messages),   'Messages')
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(quizzes),    'Quizzes')
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(snaps),      'Snaps')
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(events),     'Events')

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  res.setHeader('Content-Disposition', `attachment; filename="learnpal-${PARADIGM}-${stamp}.xlsx"`)
  res.send(buf)
})

export default router
