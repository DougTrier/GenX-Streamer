import type { PlaybackSnapshot } from '../playback/controller';
export interface SharingSettings {
  bindAddress: string;
  port: number;
  certPath: string;
  keyPath: string;
  allowHttp: boolean;
}
export interface SharingChannel {
  id: string;
  name: string;
}
export interface HostObservation {
  playback: PlaybackSnapshot;
  generation: number;
  muted: boolean;
  volume: number;
}
export type HostAction =
  | { kind: 'select'; channelId: string }
  | { kind: 'pause' }
  | { kind: 'resume' }
  | { kind: 'mute'; muted: boolean }
  | { kind: 'volume'; volume: number };
export interface SharingHost {
  snapshot(): HostObservation;
  subscribe(listener: (observation: HostObservation) => void): () => void;
  channels(): ReadonlyArray<SharingChannel>;
  /** Gate immediately before mutation; cancel only this operation's generation. */
  apply(
    action: HostAction,
    context: { signal: AbortSignal; commandId: string; authorized: () => Promise<boolean> },
  ): Promise<{ generation: number }>;
  loadSettings?(): Promise<SharingSettings | null>;
  saveSettings?(settings: SharingSettings): Promise<void>;
}
export interface RemoteCommand {
  commandId: string;
  sequence: number;
  revision: number;
  action: 'select' | 'next' | 'previous' | 'pause' | 'resume' | 'mute' | 'volume';
  channelId?: string;
  muted?: boolean;
  volume?: number;
  allowedChannelIds?: string[];
}
export interface SharingApi {
  start(settings: SharingSettings): Promise<{ address: string; pairingSecret: string }>;
  stop(): Promise<void>;
  selectionChanged(
    generation: number,
    commandId?: string,
    preservePublication?: boolean,
  ): Promise<{ generation: number; publicationRevision: number } | void>;
  publish(url: string, generation: number): Promise<{ revision: number; mediaId: string }>;
  invite(controller: boolean, channels: ReadonlyArray<SharingChannel>): Promise<string>;
  viewers(): Promise<string[]>;
  revoke(viewerId: string): Promise<void>;
  nextCommand(): Promise<RemoteCommand | null>;
  active(commandId: string): Promise<boolean>;
  allows(commandId: string, channelId: string): Promise<boolean>;
  acknowledge(commandId: string, applied: boolean): Promise<boolean>;
}
export interface SharingSnapshot {
  state: 'stopped' | 'starting' | 'sharing' | 'stopping' | 'failed';
  address: string | null;
  invitation: { secret: string; role: 'viewer' | 'controller' } | null;
  viewers: string[];
  error: string | null;
  publishedGeneration: number | null;
}
