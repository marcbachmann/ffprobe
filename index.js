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

async function ffprobeStream(stream) {
  const probe = new ProbeTask()
  const result = probe.start()
  let streamError
  try {
    for await (const chunk of stream) if (!(await probe.push(chunk))) break
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
