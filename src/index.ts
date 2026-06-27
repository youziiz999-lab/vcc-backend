import express, { Request, Response, NextFunction } from 'express'
import cors from 'cors'
import helmet from 'helmet'
import morgan from 'morgan'
import { config } from './config'
import authRoutes from './routes/authRoutes'
import customerRoutes from './routes/customerRoutes'
import adminRoutes from './routes/adminRoutes'
import { prisma } from './config/prisma'

const app = express()

app.use(helmet({ crossOriginResourcePolicy: false }))
app.use(cors({ origin: config.cors.origin, credentials: config.cors.credentials }))
app.use(morgan(config.nodeEnv === 'production' ? 'combined' : 'dev'))
app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true }))

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), uptime: process.uptime() })
})

app.use('/api/auth', authRoutes)
app.use('/api/customer', customerRoutes)
app.use('/api/admin', adminRoutes)

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('Unhandled error:', err)
  res.status(500).json({ error: config.nodeEnv === 'production' ? '服务器内部错误' : err.message })
})

app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: '接口不存在' })
})

async function connectDB(retries = 3): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      await prisma.$connect()
      console.log('[DB] Connected to database')
      return
    } catch (err) {
      console.error(`[DB] Connection attempt ${i + 1}/${retries} failed:`, err)
      if (i < retries - 1) await new Promise(r => setTimeout(r, 3000))
    }
  }
  console.warn('[DB] All connection attempts failed, server running without DB')
}

async function start() {
  const server = app.listen(config.port, '0.0.0.0', () => {
    console.log(`[Server] Running on http://localhost:${config.port} (${config.nodeEnv})`)
    console.log(`[API] Auth: /api/auth/*`)
    console.log(`[API] Customer: /api/customer/*`)
    console.log(`[API] Admin: /api/admin/*`)
  })

  connectDB()

  const shutdown = async (signal: string) => {
    console.log(`\n[Server] Received ${signal}, shutting down...`)
    server.close(async () => {
      await prisma.$disconnect()
      console.log('[Server] Closed')
      process.exit(0)
    })
    setTimeout(() => process.exit(1), 10000)
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

start()
