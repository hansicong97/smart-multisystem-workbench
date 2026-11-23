import { readFileSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parsePreferences } from '../shared/preferences.js';
import type { Preferences, PreferencesPatch } from '../shared/preferences.js';

// Preferences live in the effective userData directory so dev (SMSW-Local) and
// test profiles stay isolated. Writes are atomic and serialized; a corrupt file
// falls back to defaults instead of blocking startup.
export class PreferencesStore {
  #value: Preferences;
  readonly #file: string;
  #pending: Promise<void> = Promise.resolve();

  constructor(dir: string) {
    this.#file = join(dir, 'preferences.json');
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.#file, 'utf8').replace(/^\uFEFF/, ''));
    } catch {
      raw = undefined;
    }
    this.#value = parsePreferences(raw);
  }

  get value(): Preferences {
    return this.#value;
  }

  update(patch: PreferencesPatch): Preferences {
    const clean = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
    this.#value = { ...this.#value, ...clean };
    const json = `${JSON.stringify(this.#value, null, 2)}\n`;
    const tmp = `${this.#file}.tmp`;
    this.#pending = this.#pending.then(async () => {
      await writeFile(tmp, json, 'utf8');
      await rename(tmp, this.#file);
    }).catch((error) => {
      console.error('偏好保存失败', error);
    });
    return this.#value;
  }

  flush(): Promise<void> {
    return this.#pending;
  }
}
