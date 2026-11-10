// Host-injected native stream chunks can override Uint8Array byteLength/length
// accessors and defeat normal byte accounting. Obtain backing slots through
// intrinsic getters, then expose a plain typed-array view. Callers check their
// byte budget before copying this view to owned Buffer storage.
const intrinsic = Object.getPrototypeOf(Uint8Array.prototype) as object
const getBuffer = Object.getOwnPropertyDescriptor(intrinsic, 'buffer')!.get!
const getOffset = Object.getOwnPropertyDescriptor(intrinsic, 'byteOffset')!.get!
const getLength = Object.getOwnPropertyDescriptor(intrinsic, 'byteLength')!.get!

export function nativeV2ByteView(value: unknown): Uint8Array | null {
  if (!(value instanceof Uint8Array)) return null
  try {
    return new Uint8Array(getBuffer.call(value) as ArrayBufferLike,
      getOffset.call(value) as number, getLength.call(value) as number)
  } catch {
    // Proxy-backed or detached views have no verified typed-array backing slots.
    return null
  }
}
