/**
 * 開発エージェントのリアルタイムイベントバス
 * SSEでフロントエンドに配信するためのイベント発行基盤
 */
import { EventEmitter } from 'events';

export interface DevActivityEvent {
  type: string;
  convId: string;
  timestamp: string;
  agent?: string;
  data: Record<string, unknown>;
}

const bus = new EventEmitter();
bus.setMaxListeners(100);

export const devEventBus = bus;

export function emitDevEvent(evt: Omit<DevActivityEvent, 'timestamp'>): void {
  bus.emit('activity', { ...evt, timestamp: new Date().toISOString() } as DevActivityEvent);
}
