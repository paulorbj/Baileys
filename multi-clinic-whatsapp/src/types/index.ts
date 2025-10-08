import { WASocket } from '@adiwajshing/baileys';

export interface Clinic {
  id: string;
  name: string;
  email: string;
  phone: string;
  address?: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface WhatsAppChannel {
  id: string;
  clinicId: string;
  name: string;
  phoneNumber: string;
  isConnected: boolean;
  qrCode?: string;
  lastSeen?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface SessionInfo {
  channelId: string;
  clinicId: string;
  socket?: WASocket;
  isConnected: boolean;
  connectionState: ConnectionState;
  lastActivity: Date;
  qrCode?: string;
  retryCount: number;
}

export enum ConnectionState {
  DISCONNECTED = 'disconnected',
  CONNECTING = 'connecting',
  CONNECTED = 'connected',
  QR_REQUIRED = 'qr_required',
  PAIRING = 'pairing',
  ERROR = 'error'
}

export interface MessageEvent {
  channelId: string;
  clinicId: string;
  messageId: string;
  from: string;
  to: string;
  content: any;
  timestamp: Date;
  type: 'text' | 'image' | 'audio' | 'video' | 'document' | 'sticker';
}

export interface SessionConfig {
  channelId: string;
  clinicId: string;
  authFolder: string;
  logger: any;
  eventHandlers?: {
    onMessage?: (event: MessageEvent) => void;
    onConnectionUpdate?: (channelId: string, state: ConnectionState) => void;
    onQRCode?: (channelId: string, qr: string) => void;
  };
}

export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export interface PaginatedResponse<T> extends ApiResponse<T[]> {
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export interface CreateClinicRequest {
  name: string;
  email: string;
  phone: string;
  address?: string;
}

export interface CreateChannelRequest {
  clinicId: string;
  name: string;
  phoneNumber: string;
}

export interface SendMessageRequest {
  channelId: string;
  to: string;
  message: {
    type: 'text' | 'image' | 'audio' | 'video' | 'document';
    content: string;
    caption?: string;
  };
}