import { types as nodeUtilTypes } from 'node:util'

// Host-injected native stream chunks can override Uint8Array byteLength/length
// accessors and defeat normal byte accounting. Obtain backing slots through
// intrinsic getters, then expose a plain typed-array view. Callers check their
// byte budget before copying this view to owned Buffer storage.
const intrinsic = Object.getPrototypeOf(Uint8Array.prototype) as object
const getBuffer = Object.getOwnPropertyDescriptor(intrinsic, 'buffer')!.get!
const getOffset = Object.getOwnPropertyDescriptor(intrinsic, 'byteOffset')!.get!
const getLength = Object.getOwnPropertyDescriptor(intrinsic, 'byteLength')!.get!

export function nativeV2ByteView(value: unknown): Uint8Array | null {
  try {
    if (!(value instanceof Uint8Array)) return null
    const backing = getBuffer.call(value) as ArrayBufferLike
    // Shared memory may change on another thread between budget validation
    // and the transport's owned-byte copy. No synchronization is authorized.
    if (nodeUtilTypes.isSharedArrayBuffer(backing)) return null
    return new Uint8Array(backing,
      getOffset.call(value) as number, getLength.call(value) as number)
  } catch {
    // Proxy-backed or detached views have no verified typed-array backing slots.
    return null
  }
}
