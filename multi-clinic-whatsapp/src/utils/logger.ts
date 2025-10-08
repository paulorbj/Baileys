import winston from 'winston';
import path from 'path';

const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.json(),
  winston.format.printf(({ timestamp, level, message, stack, ...meta }) => {
    let log = `${timestamp} [${level.toUpperCase()}]: ${message}`;
    
    if (Object.keys(meta).length > 0) {
      log += ` ${JSON.stringify(meta)}`;
    }
    
    if (stack) {
      log += `\n${stack}`;
    }
    
    return log;
  })
);

const createLogger = (service: string = 'main') => {
  return winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: logFormat,
    defaultMeta: { service },
    transports: [
      new winston.transports.Console({
        format: winston.format.combine(
          winston.format.colorize(),
          winston.format.simple()
        )
      }),
      new winston.transports.File({
        filename: path.join(process.env.LOG_FILE || 'logs/app.log'),
        maxsize: 5242880, // 5MB
        maxFiles: 5
      }),
      new winston.transports.File({
        filename: path.join('logs/error.log'),
        level: 'error',
        maxsize: 5242880, // 5MB
        maxFiles: 5
      })
    ]
  });
};

// Logger principal da aplicação
export const mainLogger = createLogger('main');

// Logger específico para sessões WhatsApp
export const sessionLogger = createLogger('whatsapp-session');

// Logger para API
export const apiLogger = createLogger('api');

// Função para criar logger específico para uma clínica/canal
export const createChannelLogger = (clinicId: string, channelId: string) => {
  return createLogger(`clinic-${clinicId}-channel-${channelId}`);
};

export default mainLogger;