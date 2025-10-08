import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  ConnectionState as BaileysConnectionState,
  WASocket,
  BaileysEventMap,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore
} from '@adiwajshing/baileys';
import { Boom } from '@hapi/boom';
import NodeCache from '@cacheable/node-cache';
import QRCode from 'qrcode';
import path from 'path';
import { EventEmitter } from 'events';
import { SessionConfig, ConnectionState, MessageEvent } from '../types';
import { createChannelLogger } from '../utils/logger';

export class WhatsAppSession extends EventEmitter {
  private socket?: WASocket;
  private config: SessionConfig;
  private logger: any;
  private connectionState: ConnectionState = ConnectionState.DISCONNECTED;
  private retryCount: number = 0;
  private maxRetries: number = 5;
  private retryDelay: number = 5000; // 5 segundos
  private msgRetryCounterCache: NodeCache;
  private lastActivity: Date = new Date();
  private reconnectTimeout?: NodeJS.Timeout;

  constructor(config: SessionConfig) {
    super();
    this.config = config;
    this.logger = createChannelLogger(config.clinicId, config.channelId);
    this.msgRetryCounterCache = new NodeCache();
    
    this.logger.info('WhatsApp session initialized', {
      channelId: config.channelId,
      clinicId: config.clinicId
    });
  }

  async connect(): Promise<void> {
    try {
      this.logger.info('Starting WhatsApp connection...');
      this.setConnectionState(ConnectionState.CONNECTING);

      // Obter versão mais recente do WhatsApp Web
      const { version, isLatest } = await fetchLatestBaileysVersion();
      this.logger.info(`Using WA v${version.join('.')}, isLatest: ${isLatest}`);

      // Configurar autenticação
      const authFolder = path.join(this.config.authFolder, this.config.channelId);
      const { state, saveCreds } = await useMultiFileAuthState(authFolder);

      // Criar socket
      this.socket = makeWASocket({
        version,
        logger: this.logger,
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, this.logger),
        },
        msgRetryCounterCache: this.msgRetryCounterCache,
        generateHighQualityLinkPreview: true,
        getMessage: this.getMessage.bind(this),
        browser: ['Multi-Clinic Platform', 'Chrome', '1.0.0'],
        markOnlineOnConnect: true,
      });

      this.setupEventHandlers(saveCreds);
      this.retryCount = 0;

    } catch (error) {
      this.logger.error('Failed to connect to WhatsApp', { error: error.message });
      this.setConnectionState(ConnectionState.ERROR);
      this.scheduleReconnect();
      throw error;
    }
  }

  private setupEventHandlers(saveCreds: () => Promise<void>): void {
    if (!this.socket) return;

    this.socket.ev.process(async (events) => {
      // Atualização de conexão
      if (events['connection.update']) {
        await this.handleConnectionUpdate(events['connection.update']);
      }

      // Atualização de credenciais
      if (events['creds.update']) {
        await saveCreds();
        this.logger.debug('Credentials updated and saved');
      }

      // Mensagens recebidas
      if (events['messages.upsert']) {
        await this.handleMessagesUpsert(events['messages.upsert']);
      }

      // Atualizações de mensagens
      if (events['messages.update']) {
        this.logger.debug('Messages updated', { 
          updates: events['messages.update'].length 
        });
      }

      // Recibos de mensagens
      if (events['message-receipt.update']) {
        this.logger.debug('Message receipts updated', {
          receipts: events['message-receipt.update'].length
        });
      }

      // Atualizações de presença
      if (events['presence.update']) {
        this.logger.debug('Presence updated', {
          jid: events['presence.update'].id,
          presences: Object.keys(events['presence.update'].presences || {})
        });
      }

      // Atualizações de chats
      if (events['chats.update']) {
        this.logger.debug('Chats updated', {
          chats: events['chats.update'].length
        });
      }

      // Chamadas
      if (events.call) {
        this.logger.info('Call event received', {
          calls: events.call.length
        });
      }
    });
  }

  private async handleConnectionUpdate(update: Partial<BaileysEventMap['connection.update']>): Promise<void> {
    const { connection, lastDisconnect, qr } = update;

    this.logger.info('Connection update received', {
      connection,
      lastDisconnect: lastDisconnect?.error?.message
    });

    if (qr) {
      await this.handleQRCode(qr);
    }

    if (connection === 'close') {
      await this.handleConnectionClose(lastDisconnect);
    } else if (connection === 'open') {
      await this.handleConnectionOpen();
    } else if (connection === 'connecting') {
      this.setConnectionState(ConnectionState.CONNECTING);
    }
  }

  private async handleQRCode(qr: string): Promise<void> {
    try {
      this.logger.info('QR Code generated for pairing');
      this.setConnectionState(ConnectionState.QR_REQUIRED);
      
      // Gerar QR Code como imagem base64
      const qrCodeImage = await QRCode.toDataURL(qr);
      
      // Emitir evento com QR Code
      this.emit('qr', {
        channelId: this.config.channelId,
        clinicId: this.config.clinicId,
        qr: qrCodeImage,
        rawQr: qr
      });

      // Chamar handler personalizado se fornecido
      if (this.config.eventHandlers?.onQRCode) {
        this.config.eventHandlers.onQRCode(this.config.channelId, qrCodeImage);
      }

    } catch (error) {
      this.logger.error('Failed to generate QR code', { error: error.message });
    }
  }

  private async handleConnectionClose(lastDisconnect?: any): Promise<void> {
    const shouldReconnect = (lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
    
    this.logger.info('Connection closed', {
      shouldReconnect,
      reason: lastDisconnect?.error?.message,
      statusCode: (lastDisconnect?.error as Boom)?.output?.statusCode
    });

    if (shouldReconnect) {
      this.setConnectionState(ConnectionState.DISCONNECTED);
      this.scheduleReconnect();
    } else {
      this.logger.info('Logged out, will not reconnect');
      this.setConnectionState(ConnectionState.DISCONNECTED);
      this.emit('logged-out', {
        channelId: this.config.channelId,
        clinicId: this.config.clinicId
      });
    }
  }

  private async handleConnectionOpen(): Promise<void> {
    this.logger.info('WhatsApp connection established successfully');
    this.setConnectionState(ConnectionState.CONNECTED);
    this.retryCount = 0;
    this.updateLastActivity();

    this.emit('connected', {
      channelId: this.config.channelId,
      clinicId: this.config.clinicId
    });
  }

  private async handleMessagesUpsert(upsert: BaileysEventMap['messages.upsert']): Promise<void> {
    const { messages, type } = upsert;

    if (type === 'notify') {
      for (const message of messages) {
        try {
          const messageEvent = this.createMessageEvent(message);
          if (messageEvent) {
            this.logger.info('Message received', {
              from: messageEvent.from,
              type: messageEvent.type,
              messageId: messageEvent.messageId
            });

            this.emit('message', messageEvent);
            
            // Chamar handler personalizado se fornecido
            if (this.config.eventHandlers?.onMessage) {
              this.config.eventHandlers.onMessage(messageEvent);
            }

            this.updateLastActivity();
          }
        } catch (error) {
          this.logger.error('Failed to process message', { 
            error: error.message,
            messageId: message.key.id
          });
        }
      }
    }
  }

  private createMessageEvent(message: any): MessageEvent | null {
    if (!message.key?.remoteJid || !message.message) {
      return null;
    }

    const messageContent = message.message;
    let content: any;
    let type: MessageEvent['type'] = 'text';

    // Determinar tipo e conteúdo da mensagem
    if (messageContent.conversation) {
      content = messageContent.conversation;
      type = 'text';
    } else if (messageContent.extendedTextMessage) {
      content = messageContent.extendedTextMessage.text;
      type = 'text';
    } else if (messageContent.imageMessage) {
      content = messageContent.imageMessage;
      type = 'image';
    } else if (messageContent.audioMessage) {
      content = messageContent.audioMessage;
      type = 'audio';
    } else if (messageContent.videoMessage) {
      content = messageContent.videoMessage;
      type = 'video';
    } else if (messageContent.documentMessage) {
      content = messageContent.documentMessage;
      type = 'document';
    } else if (messageContent.stickerMessage) {
      content = messageContent.stickerMessage;
      type = 'sticker';
    } else {
      // Tipo de mensagem não suportado
      return null;
    }

    return {
      channelId: this.config.channelId,
      clinicId: this.config.clinicId,
      messageId: message.key.id || '',
      from: message.key.remoteJid,
      to: message.key.fromMe ? message.key.remoteJid : 'me',
      content,
      timestamp: new Date(message.messageTimestamp * 1000),
      type
    };
  }

  private setConnectionState(state: ConnectionState): void {
    if (this.connectionState !== state) {
      const previousState = this.connectionState;
      this.connectionState = state;
      
      this.logger.info('Connection state changed', {
        from: previousState,
        to: state
      });

      this.emit('connection-state-changed', {
        channelId: this.config.channelId,
        clinicId: this.config.clinicId,
        previousState,
        currentState: state
      });

      // Chamar handler personalizado se fornecido
      if (this.config.eventHandlers?.onConnectionUpdate) {
        this.config.eventHandlers.onConnectionUpdate(this.config.channelId, state);
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.retryCount >= this.maxRetries) {
      this.logger.error('Max retry attempts reached, giving up');
      this.setConnectionState(ConnectionState.ERROR);
      return;
    }

    const delay = this.retryDelay * Math.pow(2, this.retryCount); // Backoff exponencial
    this.retryCount++;

    this.logger.info(`Scheduling reconnect attempt ${this.retryCount}/${this.maxRetries} in ${delay}ms`);

    this.reconnectTimeout = setTimeout(() => {
      this.connect().catch(error => {
        this.logger.error('Reconnect attempt failed', { error: error.message });
      });
    }, delay);
  }

  private updateLastActivity(): void {
    this.lastActivity = new Date();
  }

  private async getMessage(key: any): Promise<any> {
    // Implementar recuperação de mensagens se necessário
    // Por enquanto, retorna uma mensagem vazia
    return undefined;
  }

  // Métodos públicos
  async sendMessage(to: string, content: any): Promise<any> {
    if (!this.socket || this.connectionState !== ConnectionState.CONNECTED) {
      throw new Error('WhatsApp is not connected');
    }

    try {
      this.logger.info('Sending message', { to, type: typeof content });
      const result = await this.socket.sendMessage(to, content);
      this.updateLastActivity();
      return result;
    } catch (error) {
      this.logger.error('Failed to send message', { 
        error: error.message, 
        to 
      });
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    this.logger.info('Disconnecting WhatsApp session...');
    
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = undefined;
    }

    if (this.socket) {
      this.socket.end(undefined);
      this.socket = undefined;
    }

    this.setConnectionState(ConnectionState.DISCONNECTED);
    this.removeAllListeners();
  }

  // Getters
  get isConnected(): boolean {
    return this.connectionState === ConnectionState.CONNECTED;
  }

  get state(): ConnectionState {
    return this.connectionState;
  }

  get channelId(): string {
    return this.config.channelId;
  }

  get clinicId(): string {
    return this.config.clinicId;
  }

  get lastActivityTime(): Date {
    return this.lastActivity;
  }

  get currentRetryCount(): number {
    return this.retryCount;
  }
}