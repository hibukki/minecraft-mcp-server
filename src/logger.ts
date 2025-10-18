import winston from 'winston';
import path from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Create logs directory path (relative to project root)
// When running from dist/, go up once to project root: dist/ -> project root
const logsDir = path.join(__dirname, '..', 'logs');

// Ensure logs directory exists
try {
  mkdirSync(logsDir, { recursive: true });
} catch (err) {
  // Directory might already exist, ignore error
}

// Winston logger configuration
const logger = winston.createLogger({
  level: 'debug',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    // Console transport (stderr for compatibility with MCP)
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ timestamp, level, message, ...meta }) => {
          const metaStr = Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
          return `${timestamp} [minecraft] [${level}] ${message}${metaStr}`;
        })
      ),
      stderrLevels: ['error', 'warn', 'info', 'debug']
    }),

    // File transport (single file for all logs)
    new winston.transports.File({
      filename: path.join(logsDir, 'minecraft.log'),
      maxsize: 10 * 1024 * 1024, // 10MB max file size
      maxFiles: 5, // Keep up to 5 rotated files
      tailable: true // Name rotated files with incrementing numbers
    })
  ]
});

// Export typed logger with convenience methods
export default logger;

// Convenience methods for specific log types
export function logToolCall(toolName: string, params: unknown, result?: unknown) {
  logger.info('MCP tool call', {
    type: 'tool_call',
    tool: toolName,
    params,
    ...(result !== undefined && { result })
  });
}

export function logGameEvent(event: string, data?: unknown) {
  logger.info('Game event', {
    type: 'game_event',
    event,
    ...(data !== undefined && { data })
  });
}

export function logBotState(updates: string) {
  logger.warn('Bot state change', {
    type: 'bot_state',
    updates
  });
}
