import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export type UserLanguage = 'zh-CN' | 'en'
export type ColorTheme = 'light' | 'dark' | 'system'

export interface UserPreferences {
  language: UserLanguage
  color_theme: ColorTheme
}

const DEFAULT_PREFERENCES: UserPreferences = {
  language: 'zh-CN',
  color_theme: 'system',
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export class UserPreferencesStore {
  readonly directory: string
  readonly file: string

  constructor(directory = path.join(os.homedir(), '.capybara')) {
    this.directory = directory
    this.file = path.join(directory, 'settings.json')
    fs.mkdirSync(directory, { recursive: true })
  }

  read(): UserPreferences {
    if (!fs.existsSync(this.file)) return { ...DEFAULT_PREFERENCES }
    return this.validate(JSON.parse(fs.readFileSync(this.file, 'utf8')))
  }

  save(value: unknown): UserPreferences {
    if (!isObject(value)) throw new Error('user preferences must be an object')
    const next = this.validate({ ...this.read(), ...value })
    fs.writeFileSync(this.file, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    return next
  }

  private validate(value: unknown): UserPreferences {
    if (!isObject(value)) throw new Error('user preferences must be an object')
    if (value.language !== 'zh-CN' && value.language !== 'en') {
      throw new Error('language must be zh-CN or en')
    }
    if (!['light', 'dark', 'system'].includes(String(value.color_theme))) {
      throw new Error('color_theme must be light, dark, or system')
    }
    return {
      language: value.language,
      color_theme: value.color_theme as ColorTheme,
    }
  }
}
