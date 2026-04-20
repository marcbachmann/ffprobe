'use strict'
const {Readable} = require('stream')
const {ProbeTask} = require('./binding.js')

/**
 * Probe a media file by path, Buffer/Uint8Array, Node.js Readable, or Web ReadableStream.
 *
 * @param {string | Buffer | Uint8Array | Readable | ReadableStream} input
 * @returns {Promise<import('./index.d.ts').ProbeResult>}
 */
function ffprobe(input) {
  if (typeof input === 'string') return ProbeTask.probeFile(input)
  if (input instanceof Uint8Array) return ProbeTask.probeBuffer(input)
  if (input instanceof Readable) return ffprobeStream(input)
  if (input instanceof ReadableStream) return ffprobeStream(input)
  throw new TypeError(
    'ffprobe: input must be a file path, Buffer, Uint8Array, Readable, or ReadableStream'
  )
}

// Number of stream chunks to batch per push() call, reducing JS→Rust
// Promise round-trips at the cost of slightly larger per-call allocations.
const PUSH_BATCH_SIZE = 4

async function ffprobeStream(stream) {
  const probe = new ProbeTask()
  const result = probe.start()
  let streamError
  try {
    let batch = []
    for await (const chunk of stream) {
      batch.push(chunk)
      if (batch.length >= PUSH_BATCH_SIZE) {
        const accepted = await probe.push(batch)
        batch = []
        if (!accepted) break
      }
    }
    if (batch.length > 0) await probe.push(batch)
  } catch (err) {
    streamError = err
  } finally {
    probe.finish()
  }
  if (streamError) {
    result.catch(() => {})
    throw streamError
  }
  return result
}

module.exports = ffprobe
