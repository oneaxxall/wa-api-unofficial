import pino from 'pino'
import 'dotenv/config'

// DEBUG=1 override LOG_LEVEL ke debug, biar gampang pas troubleshooting
const isDebug = process.env.DEBUG === '1' || process.env.DEBUG === 'true'
const level = isDebug ? 'debug' : (process.env.LOG_LEVEL || 'info')

export default pino({
  transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } },
  level,
})
