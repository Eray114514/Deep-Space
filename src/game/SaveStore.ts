import { DEFAULT_INVENTORY, type SaveData } from './types';

const KEY = 'astral-frontier-save-v1';

export class SaveStore {
  load(): SaveData | undefined {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return undefined;
      const parsed = JSON.parse(raw) as SaveData;
      return parsed.version === 1 ? parsed : undefined;
    } catch { return undefined; }
  }

  save(data: Omit<SaveData, 'version' | 'timestamp'>): void {
    localStorage.setItem(KEY, JSON.stringify({ ...data, version: 1, timestamp: Date.now() } satisfies SaveData));
  }

  clear(): void { localStorage.removeItem(KEY); }

  default(): SaveData {
    return { version: 1, timestamp: Date.now(), systemId: 0, mode: 'space', inventory: { ...DEFAULT_INVENTORY }, health: 100, shield: 100, shipIntegrity: 100, discovered: [0] };
  }
}
