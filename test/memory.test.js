'use strict'

/**
 * Memory usage tests — NOT included in the default test suite.
 *
 * Run manually: node --expose-gc --test test/memory.test.js
 *
 * Requires system `ffmpeg` to generate the large test file.
 * Skipped automatically when ffmpeg is not available.
 */

const {test, describe, before} = require('node:test')
const assert = require('node:assert/strict')
const {createReadStream, existsSync, statSync} = require('node:fs')
const {execFile} = require('node:child_process')
const {promisify} = require('node:util')
const os = require('node:os')
const path = require('node:path')
const ffprobe = require('..')

const execFileAsync = promisify(execFile)

// Cached across runs to avoid re-encoding on every test run
const LARGE_FILE = path.join(os.tmpdir(), 'ffprobe-memory-test-10min.mp4')

const MB = 1024 * 1024
const PARALLELISM = 5
const ITERATIONS = 200

// A real memory leak grows continuously with every iteration.  Allocator arenas
// (jemalloc, system malloc) grow in one-time steps and then plateau.
// We detect leaks by checking the *tail* of the RSS series: if the last quarter
// of iterations still drifts by more than this many MB, it indicates continuous
// growth rather than a one-time arena expansion.
const MAX_TAIL_DRIFT_MB = 5

function rssMB() {
  return process.memoryUsage().rss / MB
}

async function hasFfmpeg() {
  try {
    await execFileAsync('ffmpeg', ['-version'], {timeout: 5_000})
    return true
  } catch {
    return false
  }
}

async function generateLargeFile() {
  // Re-use existing file if it is already large enough (>80 MB)
  if (existsSync(LARGE_FILE)) {
    const {size} = statSync(LARGE_FILE)
    if (size > 80 * MB) return size
  }

  // Generate a 10-minute 1080p H.264+AAC file.  Using a noise source prevents
  // the encoder from compressing the video down to near-zero, ensuring the file
  // stays large (≈100 MB at the chosen bitrates).
  await execFileAsync(
    'ffmpeg',
    [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'nullsrc=s=1920x1080,noise=alls=20:allf=t+u,format=yuv420p',
      '-f',
      'lavfi',
      '-i',
      'anullsrc=channel_layout=stereo:sample_rate=44100',
      '-t',
      '600',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-b:v',
      '1200k',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-movflags',
      '+faststart',
      LARGE_FILE
    ],
    {timeout: 10 * 60_000}
  )

  const {size} = statSync(LARGE_FILE)
  return size
}

async function gcAndSettle() {
  if (typeof global.gc === 'function') global.gc()
  await new Promise((r) => setImmediate(r))
  if (typeof global.gc === 'function') global.gc()
  await new Promise((r) => setImmediate(r))
}

/**
 * Runs `PARALLELISM` probes in parallel, `ITERATIONS` times.
 * Logs RSS after each iteration and asserts that RSS is no longer growing
 * in the final quarter of iterations.
 */
async function runLeakCheck(label, probeFactory) {
  await gcAndSettle()
  const rssAfter = []

  for (let i = 0; i < ITERATIONS; i++) {
    await Promise.all(Array.from({length: PARALLELISM}, probeFactory))
    await gcAndSettle()
    rssAfter.push(rssMB())
  }

  const lines = rssAfter.map((v, i) => `    [${String(i + 1).padStart(2)}] ${v.toFixed(1)} MB`)
  console.log(`  ${label} RSS after each iteration:\n${lines.join('\n')}`)

  // A real leak grows continuously. Allocator arena expansions are one-time
  // step increases that then plateau.  Detect leaks by measuring drift only
  // within the final quarter of iterations — by that point any step-growth
  // from arena expansion should already have happened.
  const tailStart = Math.floor(ITERATIONS * 0.75)
  const tailFirst = rssAfter[tailStart]
  const tailLast = rssAfter[ITERATIONS - 1]
  const tailDrift = tailLast - tailFirst

  assert.ok(
    tailDrift < MAX_TAIL_DRIFT_MB,
    `${label}: RSS still growing in final quarter of iterations ` +
      `(+${tailDrift.toFixed(1)} MB from iteration ${tailStart + 1} to ${ITERATIONS}, ` +
      `limit: ${MAX_TAIL_DRIFT_MB} MB) — possible memory leak`
  )
}

describe('memory: large file probing does not leak', async () => {
  let ffmpegAvailable = false
  let fileSizeMB = 0

  before(async () => {
    ffmpegAvailable = await hasFfmpeg()
    if (!ffmpegAvailable) return

    // probe once so the native module and thread pool are fully initialized
    await ffprobe(createReadStream(path.join(__dirname, 'test_data', 'test_audio.flac')))

    const bytes = await generateLargeFile()
    fileSizeMB = bytes / MB
    console.log(`Test file: ${LARGE_FILE} (${fileSizeMB.toFixed(1)} MB)`)
  })

  test(`${ITERATIONS}x ${PARALLELISM} parallel file-path probes do not leak`, async (t) => {
    if (!ffmpegAvailable) return t.skip('ffmpeg not available')
    await runLeakCheck('file-path', () => ffprobe(LARGE_FILE))
  })

  test(`${ITERATIONS}x ${PARALLELISM} parallel buffer probes do not leak`, async (t) => {
    if (!ffmpegAvailable) return t.skip('ffmpeg not available')
    // Load once — buffer probe uses input_from_stream with a Cursor (same AVIO
    // code path as stream but without the channel/temp-file machinery).
    // If this leaks: issue is in ffmpeg-next's AVIO handling.
    // If stable: issue is in the StreamingFile/channel/NamedTempFile path.
    const {readFileSync} = require('node:fs')
    const buf = readFileSync(LARGE_FILE)
    await runLeakCheck('buffer', () => ffprobe(buf))
  })

  test(`${ITERATIONS}x ${PARALLELISM} parallel stream probes do not leak`, async (t) => {
    if (!ffmpegAvailable) return t.skip('ffmpeg not available')
    await runLeakCheck('stream', () => ffprobe(createReadStream(LARGE_FILE)))
  })
})
