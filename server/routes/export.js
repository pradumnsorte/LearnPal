import { Router } from 'express'
import * as XLSX from 'xlsx'
import db from '../db.js'

const router = Router()

// ── Paradigm-specific event aliases ──────────────────────────────────────────
// The Comparable sheet uses canonical names; this maps which raw event names
// from THIS paradigm count toward each canonical metric.
const PARADIGM = 'intermittent'
const ALIAS = {
  quiz_skipped:     ['quiz_skipped'],
  quiz_explained:   ['quiz_explained'],
  quiz_reviewed:    ['quiz_review_opened'],
  paradigm_feature: ['snap_started', 'snap_cancelled'],
}

// ── CSV helpers ──────────────────────────────────────────────────────────────
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

// ── Comparable-sheet row builder ─────────────────────────────────────────────
// Returns one row per session with the unified numeric schema described in
// docs. Computes time-paired metrics (active video, tab blur) in JS rather than
// SQL for clarity.
const buildComparableRows = () => {
  const sessions = db.prepare('SELECT * FROM sessions ORDER BY created_at ASC').all()

  const placeholders = (arr) => arr.map(() => '?').join(',')

  const sumPairedDeltas = (events, openType, closeTypes) => {
    // Pair each `openType` event with the next `closeType` event and sum
    // the time deltas (in seconds). Unpaired open events at end of session
    // are ignored (we don't speculate about session end).
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

    const tabBlurredSeconds = Math.round(
      sumPairedDeltas(events, 'tab_blurred', ['tab_focused', 'session_end'])
    )

    const countByType = (types) => events.filter((e) => types.includes(e.event_type)).length

    // Video seek breakdown via meta JSON
    const seekEvents = events.filter((e) => e.event_type === 'video_seek')
    const parseMetaDelta = (e) => {
      try { return JSON.parse(e.meta ?? '{}').delta ?? 0 } catch { return 0 }
    }
    const videoSeeksBackward = seekEvents.filter((e) => parseMetaDelta(e) < 0).length
    const videoSeeksForward  = seekEvents.filter((e) => parseMetaDelta(e) > 0).length

    // Quiz aggregates
    const total = attempts.length
    const correct = attempts.filter((a) => a.is_correct === 1).length
    const accuracyPct = total > 0 ? Math.round((correct / total) * 1000) / 10 : null

    const timeMean = (arr) => {
      const valid = arr.map((a) => a.time_to_answer_seconds).filter((v) => v != null)
      if (valid.length === 0) return null
      return Math.round((valid.reduce((a, b) => a + b, 0) / valid.length) * 100) / 100
    }
    const avgTimeAll     = timeMean(attempts)
    const avgTimeCorrect = timeMean(attempts.filter((a) => a.is_correct === 1))
    const avgTimeWrong   = timeMean(attempts.filter((a) => a.is_correct === 0))
    const highestDiff    = attempts.reduce((m, a) => Math.max(m, a.difficulty ?? 0), 0) || null

    const diffStats = (lvl) => {
      const sub = attempts.filter((a) => a.difficulty === lvl)
      return {
        attempts: sub.length,
        correct: sub.filter((a) => a.is_correct === 1).length,
      }
    }
    const d1 = diffStats(1), d2 = diffStats(2), d3 = diffStats(3)

    return {
      session_id: s.id,
      participant_id: s.participant_id ?? '',
      paradigm: s.paradigm ?? PARADIGM,
      started_at: s.created_at,

      session_duration_seconds: sessionDurationSeconds ?? '',
      active_video_seconds: activeVideoSeconds,
      final_video_position_seconds: finalVideoPosition ?? '',
      time_to_first_interaction_seconds: timeToFirstInteractionSeconds ?? '',

      chat_messages_sent: messagesSent,
      transcript_clicks: countByType(['transcript_clicked']),
      video_pauses: countByType(['video_pause']),
      video_seeks_total: seekEvents.length,
      video_seeks_backward: videoSeeksBackward,
      video_seeks_forward: videoSeeksForward,
      tab_blurred_count: countByType(['tab_blurred']),
      tab_blurred_seconds_total: tabBlurredSeconds,

      quiz_explanations_requested: countByType(ALIAS.quiz_explained),
      quiz_reviewed_count: countByType(ALIAS.quiz_reviewed),

      quiz_attempts_total: total,
      quiz_correct: correct,
      quiz_accuracy_pct: accuracyPct ?? '',
      quiz_skipped_total: countByType(ALIAS.quiz_skipped),
      avg_time_to_answer_seconds: avgTimeAll ?? '',
      avg_time_to_correct_seconds: avgTimeCorrect ?? '',
      avg_time_to_wrong_seconds: avgTimeWrong ?? '',
      highest_difficulty_reached: highestDiff ?? '',
      diff1_attempts: d1.attempts, diff1_correct: d1.correct,
      diff2_attempts: d2.attempts, diff2_correct: d2.correct,
      diff3_attempts: d3.attempts, diff3_correct: d3.correct,

      // Paradigm-specific feature engagement (per Intermittent: snap interactions)
      snaps_taken: snapsTaken,
      paradigm_feature_engagements: countByType(ALIAS.paradigm_feature),
    }
  })
}

// ── Summary CSV (kept for backwards compat) ──────────────────────────────────
router.get('/', (req, res) => {
  const rows = buildComparableRows()
  const headers = rows[0] ? Object.keys(rows[0]) : ['session_id']
  sendCsv(res, 'learnpal-sessions.csv', toCsv(rows, headers))
})

// ── Detailed exports ─────────────────────────────────────────────────────────
router.get('/messages', (req, res) => {
  const rows = db.prepare(`
    SELECT m.id, m.session_id, s.participant_id, s.paradigm, m.role, m.provider, m.source, m.content, m.created_at
    FROM messages m JOIN sessions s ON s.id = m.session_id
    ORDER BY m.session_id ASC, m.created_at ASC
  `).all()
  const headers = ['id', 'session_id', 'participant_id', 'paradigm', 'role', 'provider', 'source', 'content', 'created_at']
  sendCsv(res, 'learnpal-messages.csv', toCsv(rows, headers))
})

router.get('/quizzes', (req, res) => {
  const rows = db.prepare(`
    SELECT q.id, q.session_id, s.participant_id, s.paradigm, q.question, q.options, q.correct_index,
           q.selected_index, q.is_correct, q.difficulty, q.provider,
           q.time_to_answer_seconds, q.created_at
    FROM quiz_attempts q JOIN sessions s ON s.id = q.session_id
    ORDER BY q.session_id ASC, q.created_at ASC
  `).all()
  const headers = ['id', 'session_id', 'participant_id', 'paradigm', 'question', 'options', 'correct_index',
                   'selected_index', 'is_correct', 'difficulty', 'provider',
                   'time_to_answer_seconds', 'created_at']
  sendCsv(res, 'learnpal-quizzes.csv', toCsv(rows, headers))
})

router.get('/snaps', (req, res) => {
  // image_data deliberately excluded — base64 blobs bloat exports.
  const rows = db.prepare(`
    SELECT n.id, n.session_id, s.participant_id, s.paradigm, n.timestamp_seconds, n.timestamp_str,
           n.region, n.user_prompt, n.ai_response, n.provider, n.created_at
    FROM snaps n JOIN sessions s ON s.id = n.session_id
    ORDER BY n.session_id ASC, n.created_at ASC
  `).all()
  const headers = ['id', 'session_id', 'participant_id', 'paradigm', 'timestamp_seconds', 'timestamp_str',
                   'region', 'user_prompt', 'ai_response', 'provider', 'created_at']
  sendCsv(res, 'learnpal-snaps.csv', toCsv(rows, headers))
})

router.get('/events', (req, res) => {
  const rows = db.prepare(`
    SELECT e.id, e.session_id, s.participant_id, s.paradigm, e.event_type, e.playback_seconds, e.meta, e.created_at
    FROM events e JOIN sessions s ON s.id = e.session_id
    ORDER BY e.session_id ASC, e.created_at ASC
  `).all()
  const headers = ['id', 'session_id', 'participant_id', 'paradigm', 'event_type', 'playback_seconds', 'meta', 'created_at']
  sendCsv(res, 'learnpal-events.csv', toCsv(rows, headers))
})

router.get('/comparable', (req, res) => {
  const rows = buildComparableRows()
  const headers = rows[0] ? Object.keys(rows[0]) : ['session_id']
  sendCsv(res, 'learnpal-comparable.csv', toCsv(rows, headers))
})

// ── Single XLSX with one sheet per table + Comparable ────────────────────────
router.get('/all', (req, res) => {
  const comparable = buildComparableRows()

  const summary = db.prepare(`
    SELECT s.id AS session_id, s.participant_id, s.paradigm, s.video_id, s.video_title, s.created_at,
      (SELECT COUNT(*) FROM messages       WHERE session_id = s.id) AS messages_sent,
      (SELECT COUNT(*) FROM snaps          WHERE session_id = s.id) AS snaps_taken,
      (SELECT COUNT(*) FROM quiz_attempts  WHERE session_id = s.id) AS quiz_attempts,
      (SELECT COUNT(*) FROM quiz_attempts  WHERE session_id = s.id AND is_correct = 1) AS quiz_correct,
      (SELECT playback_seconds FROM events WHERE session_id = s.id AND event_type = 'session_end' ORDER BY created_at DESC LIMIT 1) AS final_video_position
    FROM sessions s ORDER BY s.created_at ASC
  `).all()

  const messages = db.prepare(`
    SELECT m.id, m.session_id, s.participant_id, s.paradigm, m.role, m.provider, m.source, m.content, m.created_at
    FROM messages m JOIN sessions s ON s.id = m.session_id
    ORDER BY m.session_id ASC, m.created_at ASC
  `).all()

  const quizzes = db.prepare(`
    SELECT q.id, q.session_id, s.participant_id, s.paradigm, q.question, q.options, q.correct_index,
           q.selected_index, q.is_correct, q.difficulty, q.provider,
           q.time_to_answer_seconds, q.created_at
    FROM quiz_attempts q JOIN sessions s ON s.id = q.session_id
    ORDER BY q.session_id ASC, q.created_at ASC
  `).all()

  const snaps = db.prepare(`
    SELECT n.id, n.session_id, s.participant_id, s.paradigm, n.timestamp_seconds, n.timestamp_str,
           n.region, n.user_prompt, n.ai_response, n.provider, n.created_at
    FROM snaps n JOIN sessions s ON s.id = n.session_id
    ORDER BY n.session_id ASC, n.created_at ASC
  `).all()

  const events = db.prepare(`
    SELECT e.id, e.session_id, s.participant_id, s.paradigm, e.event_type, e.playback_seconds, e.meta, e.created_at
    FROM events e JOIN sessions s ON s.id = e.session_id
    ORDER BY e.session_id ASC, e.created_at ASC
  `).all()

  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(comparable), 'Comparable')
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summary),    'Summary')
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
