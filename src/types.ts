export type Orientation = 'popup' | 'dropdown';

export interface MemoryPreset {
  /** Memory slot on the control box (1 = HOME). */
  slot: 1 | 2 | 3;
  name: string;
  /** Where this memory sits on the 0–100 scale (0 = hidden, 100 = fully visible). */
  position?: number;
}

export interface LiftConfig {
  name: string;
  host: string;
  port?: number;
  model?: string;
  orientation?: Orientation;
  travelTimeSeconds?: number;
  partialPositioning?: boolean;
  pollIntervalSeconds?: number;
  movingPollIntervalMs?: number;
  requestTimeoutMs?: number;
  websocketUrl?: string;
  memoryPresets?: MemoryPreset[];
  debug?: boolean;
}
