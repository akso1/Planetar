// Simple hash function to get a number from a string
function simpleHash(str: string) {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i)
    hash = (hash << 5) - hash + char
    hash |= 0 // Convert to 32bit integer
  }
  return Math.abs(hash)
}

/** Telegram-style name palette — readable on dark chat surfaces */
const USER_NAME_COLORS = [
  '#e17076',
  '#faa774',
  '#e5b55d',
  '#7bc862',
  '#6ec9cb',
  '#65aadd',
  '#a695e7',
  '#ee7aae',
  '#4db6ac',
  '#ff8a65',
  '#81c784',
  '#64b5f6',
] as const

/** Stable accent color for a Matrix user id (names + @mentions). */
export function getUserColor(userId: string): string {
  if (!userId) return USER_NAME_COLORS[5]
  return USER_NAME_COLORS[simpleHash(userId) % USER_NAME_COLORS.length]
}

/** Same color with alpha — mention pill backgrounds, reply bars, etc. */
export function getUserColorAlpha(userId: string, alpha: number): string {
  const hex = getUserColor(userId)
  const a = Math.min(1, Math.max(0, alpha))
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r}, ${g}, ${b}, ${a})`
}

// Generate a color from a string
function stringToColor(str: string) {
  const hash = simpleHash(str)
  const hue = hash % 360
  // Using fixed saturation and lightness for pleasant colors
  return `hsl(${hue}, 70%, 50%)`
}

// Generate a gradient from a string
export function getGradient(str: string) {
  const color1 = stringToColor(str)
  const color2 = stringToColor(str + 'salt') // Add salt for a different second color
  return `linear-gradient(to bottom right, ${color1}, ${color2})`
}
