import { win32 } from 'node:path';

/** Lexical admission only. The caller still owns file identity, selection and native custody. */
export function isNativeAbsolutePath(value: unknown, platform: NodeJS.Platform = process.platform): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 8192 || value.includes('\0')) { return false; }
  if (platform !== 'win32') { return value.startsWith('/'); }
  const root = win32.parse(value).root;
  return /^[A-Za-z]:\\/.test(value) && win32.isAbsolute(value) && win32.normalize(value) === value && value.length > root.length &&
    value.slice(root.length).split('\\').every(segment => segment.length > 0 && !/[ .]$/.test(segment) &&
      !/[<>:"|?*\x00-\x1f]/.test(segment) &&
      !/^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(segment));
}
