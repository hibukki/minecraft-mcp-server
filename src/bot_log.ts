import logger from './logger.js';

type LogLevel = "info" | "warn" | "error";

export function log(level: LogLevel, message: string) {
  logger[level](message);
}

export function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}