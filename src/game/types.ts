export type GameMode =
  | 'menu'
  | 'opening'
  | 'space'
  | 'starmap'
  | 'warp-charge'
  | 'warp'
  | 'warp-arrival'
  | 'atmosphere'
  | 'ascent'
  | 'surface-flight'
  | 'landed'
  | 'on-foot'
  | 'paused';

export type Biome = 'basalt' | 'ice' | 'mycelium';

export interface StarSystem {
  id: number;
  name: string;
  spectral: 'A' | 'F' | 'G' | 'K' | 'M';
  position: [number, number, number];
  reachable: boolean;
  distance: number;
  color: number;
  planet: PlanetSpec;
}

export interface PlanetSpec {
  id: string;
  name: string;
  biome: Biome;
  radius: number;
  atmosphere: number;
  seed: number;
  landable: boolean;
  primary: number;
  secondary: number;
  accent: number;
}

export interface InventoryState {
  ferrite: number;
  crystal: number;
  biomass: number;
  warpCells: number;
}

export interface SaveData {
  version: 1;
  systemId: number;
  mode: 'space' | 'surface-flight' | 'landed' | 'on-foot';
  inventory: InventoryState;
  health: number;
  shield: number;
  shipIntegrity: number;
  discovered: number[];
  timestamp: number;
}

export interface GameSnapshot {
  mode: GameMode;
  speed: number;
  altitude: number;
  health: number;
  shield: number;
  shipIntegrity: number;
  inventory: InventoryState;
  system: StarSystem;
  target?: StarSystem;
  objective: string;
  prompt: string;
  scanner: number;
  quality: 'high' | 'balanced';
  boost: number;
}

export interface FlightState {
  position: [number, number, number];
  quaternion: [number, number, number, number];
  velocity: [number, number, number];
  speed: number;
  throttle: number;
  rollInput: number;
  boost?: number;
}

export const DEFAULT_INVENTORY: InventoryState = {
  ferrite: 18,
  crystal: 4,
  biomass: 0,
  warpCells: 3,
};
