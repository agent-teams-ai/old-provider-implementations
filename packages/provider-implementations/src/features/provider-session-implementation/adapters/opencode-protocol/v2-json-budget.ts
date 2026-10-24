import { executionAssert } from './v2-failures.ts'

export function checkOpenCodeReadJson(text: string): void {
  let depth = 0, tokens = 0, quoted = false, escaped = false, atom = false
  for (const char of text) {
    if (quoted) {
      if (escaped) {escaped = false}
      else if (char === '\\') {escaped = true}
      else if (char === '"') {quoted = false}
      continue
    }
    if (char === '"') { quoted = true; atom = false; tokens++ }
    else if (char === '{' || char === '[') { depth++; tokens++; atom = false }
    else if (char === '}' || char === ']') { depth--; atom = false }
    else if (char === ',' || char === ':' || /\s/.test(char)) {atom = false}
    else if (!atom) { tokens++; atom = true }
    executionAssert(depth <= 32 && tokens <= 200_000)
  }
}

export function checkExecutionSse(text: string): void {
  const frames = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n\n')
  executionAssert(frames.length <= 4098, 'frame_limit')
  executionAssert(frames.at(-1) === '', 'incomplete_stream')
  for (const frame of frames) {
    executionAssert(Buffer.byteLength(frame) <= 256 * 1024, 'frame_limit')
    const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n')
    if (data) { checkOpenCodeReadJson(data); JSON.parse(data) }
  }
}
