import winston from 'winston';
import path from 'path';
import { config } from '../config';
import { getDB } from '../db/database';

export const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({
      filename: path.join(config.log.dir, 'error.log'),
      level: 'error',
    }),
    new winston.transports.File({
      filename: path.join(config.log.dir, 'combined.log'),
    }),
  ],
});

if (config.server.env !== 'production') {
  logger.add(new winston.transports.Console({
    format: winston.format.simple(),
  }));
}

export function dbLog(
  level: string,
  source: string,
  message: string,
  metadata?: Record<string, unknown>
): void {
  try {
    const db = getDB();
    db.prepare(`
      INSERT INTO logs (level, source, message, metadata)
      VALUES (?, ?, ?, ?)
    `).run(level, source, message, metadata ? JSON.stringify(metadata) : null);
  } catch {
    logger.error('Failed to write DB log', { source, message });
  }
}
