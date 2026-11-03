/**
 * 訪客身分（現階段沒有帳號系統）。名稱與 id 存在瀏覽器，重新整理後保持一致；
 * 伺服器用 guestId 防止同一個瀏覽器重複加入同一場對戰。
 */
export interface GuestProfile {
  guestId: string;
  name: string;
}

const KEY = 'frontline.guest.v1';

function randomId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function sanitizeName(name: string): string {
  const cleaned = Array.from(name)
    .filter((ch) => ch.charCodeAt(0) >= 32 && ch !== '<' && ch !== '>')
    .join('')
    .trim()
    .slice(0, 16);
  return cleaned || `士兵${Math.floor(Math.random() * 9000 + 1000)}`;
}

export function loadProfile(): GuestProfile {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<GuestProfile>;
      if (typeof parsed.guestId === 'string' && typeof parsed.name === 'string') {
        return { guestId: parsed.guestId, name: sanitizeName(parsed.name) };
      }
    }
  } catch {
    // 使用新的訪客身分
  }
  const profile = { guestId: randomId(), name: sanitizeName('') };
  saveProfile(profile);
  return profile;
}

export function saveProfile(profile: GuestProfile): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(profile));
  } catch {
    // 忽略
  }
}
