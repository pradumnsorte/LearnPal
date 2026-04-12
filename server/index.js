import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import sessionsRouter from './routes/sessions.js'
import chatRouter from './routes/chat.js'
import quizRouter from './routes/quiz.js'
import snapsRouter from './routes/snaps.js'

const app = express()
const PORT = process.env.PORT || 3001

app.use(cors({ origin: 'http://localhost:5173' }))
app.use(express.json({ limit: '10mb' }))  // 10mb for base64 snap images

app.use('/api/sessions', sessionsRouter)
app.use('/api/chat',     chatRouter)
app.use('/api/quiz',     quizRouter)
app.use('/api/snaps',    snapsRouter)

app.listen(PORT, () => {
  console.log(`LearnPal server running on http://localhost:${PORT}`)
})
