'use strict'
const {test, describe, before, after} = require('node:test')
const assert = require('assert/strict')
const {createReadStream, readFileSync, readdirSync, mkdtempSync, rmSync} = require('fs')
const {join, extname} = require('path')
const {Readable} = require('stream')
const os = require('os')
const ffprobe = require('..')

const testData = join(__dirname, 'test_data')
const TEST_FILE = join(testData, 'test.mp4')
const TEST_FILE_LARGE = join(testData, 'test_large.mp4')
const TEST_FILE_LARGE_NO_FASTSTART = join(testData, 'test_large_no_faststart.mp4')
const TEST_FILE_CORRUPT = join(testData, 'corrupt.mp4')

async function isRejected(promise) {
  try {
    await promise
    assert.fail('Expected promise to reject, but it resolved')
  } catch (err) {
    if (err instanceof assert.AssertionError) throw err
    return err
  }
}

async function allEqual(...all) {
  const results = await Promise.all(all)
  const first = results[0]
  for (const r of results) assert.deepEqual(r, first)
  return first
}

describe('ffprobe(path)', () => {
  test('returns streams array', async () => {
    const r = await ffprobe(TEST_FILE)
    assert.ok(Array.isArray(r.streams))
    assert.equal(r.streams.length, 2)
  })

  test('video stream has correct dimensions', async () => {
    const r = await ffprobe(TEST_FILE)
    const v = r.streams.find((s) => s.codec_type === 'video')
    assert.ok(v)
    assert.equal(v.width, 64)
    assert.equal(v.height, 64)
    assert.equal(v.codec_name, 'h264')
  })

  test('audio stream exists', async () => {
    const r = await ffprobe(TEST_FILE)
    const a = r.streams.find((s) => s.codec_type === 'audio')
    assert.ok(a)
    assert.equal(a.codec_name, 'aac')
  })

  test('format has duration ~1s', async () => {
    const r = await ffprobe(TEST_FILE)
    const dur = parseFloat(r.format.duration)
    assert.ok(dur > 0.5 && dur < 2.0, `expected ~1s, got ${dur}`)
  })

  test('rejects for non-existent file', async () => {
    const err = await isRejected(ffprobe('/nonexistent/file.mp4'))
    assert.ok(err instanceof Error)
    assert.match(err.message, /No such file or directory/)
    assert.equal(err.code, 'GenericFailure')
  })
})

describe('ffprobe(buffer)', () => {
  test('buffer: same result as file path', async () => {
    const [rFile, rBuf] = await Promise.all([ffprobe(TEST_FILE), ffprobe(readFileSync(TEST_FILE))])
    assert.equal(rFile.streams.length, rBuf.streams.length)
    const vFile = rFile.streams.find((s) => s.codec_type === 'video')
    const vBuf = rBuf.streams.find((s) => s.codec_type === 'video')
    assert.equal(vFile.codec_name, vBuf.codec_name)
    assert.equal(vFile.width, vBuf.width)
  })

  test('buffer: same result as file path (moov at end)', async () => {
    const [rFile, rBuf] = await Promise.all([
      ffprobe(TEST_FILE_LARGE_NO_FASTSTART),
      ffprobe(readFileSync(TEST_FILE_LARGE_NO_FASTSTART))
    ])
    assert.equal(rFile.streams.length, rBuf.streams.length)
    const vFile = rFile.streams.find((s) => s.codec_type === 'video')
    const vBuf = rBuf.streams.find((s) => s.codec_type === 'video')
    assert.equal(vFile.codec_name, vBuf.codec_name)
    assert.equal(vFile.width, vBuf.width)
  })

  test('accepts Uint8Array (non-Buffer)', async () => {
    const buf = readFileSync(TEST_FILE)
    const u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
    const r = await ffprobe(u8)
    assert.ok(Array.isArray(r.streams))
    assert.equal(r.streams.length, 2)
  })

  test('rejects on empty buffer', async () => {
    const err = await isRejected(ffprobe(Buffer.alloc(0)))
    assert.ok(err instanceof Error)
    assert.match(err.message, /Invalid data found when processing input/)
    assert.equal(err.code, 'GenericFailure')
  })

  test('rejects on non-media bytes', async () => {
    const err = await isRejected(ffprobe(Buffer.from('not a media file at all, just garbage text')))
    assert.ok(err instanceof Error)
    assert.match(err.message, /Invalid data found when processing input/)
    assert.equal(err.code, 'GenericFailure')
  })

  test('rejects on corrupt video', async function () {
    const err = await isRejected(ffprobe(TEST_FILE_CORRUPT))
    assert.ok(err instanceof Error)
    assert.match(err.message, /Invalid data found when processing input/)
    assert.equal(err.code, 'GenericFailure')
  })
})

describe('ffprobe(stream)', () => {
  test('readable: same result as file path', async () => {
    const [rFile, rStream] = await Promise.all([
      ffprobe(TEST_FILE),
      ffprobe(createReadStream(TEST_FILE))
    ])
    assert.equal(rFile.streams.length, rStream.streams.length)
    const vFile = rFile.streams.find((s) => s.codec_type === 'video')
    const vStream = rStream.streams.find((s) => s.codec_type === 'video')
    assert.equal(vFile.codec_name, vStream.codec_name)
    assert.equal(vFile.width, vStream.width)
  })

  test('readable: accepts Uint8Array chunks (not Buffer)', async () => {
    // Node.js PassThrough streams and some transform streams can yield Uint8Array
    // instead of Buffer. Ensure we handle them correctly.
    const fileData = readFileSync(TEST_FILE)
    const stream = new Readable({read() {}})
    setImmediate(() => {
      // Push raw Uint8Array, not a Buffer
      stream.push(new Uint8Array(fileData.buffer, fileData.byteOffset, fileData.byteLength))
      stream.push(null)
    })
    const r = await ffprobe(stream)
    assert.ok(Array.isArray(r.streams))
    assert.equal(r.streams.length, 2)
  })

  test('throws TypeError for invalid input', async () => {
    assert.throws(
      () => ffprobe(42),
      (err) => {
        assert.ok(err instanceof TypeError)
        assert.equal(
          err.message,
          'ffprobe: input must be a file path, Buffer, Uint8Array, Readable, or ReadableStream'
        )
        return true
      }
    )
  })
})

describe('event loop responsiveness', () => {
  // Verify ffprobe does not block the main JS thread. If it did, setImmediate
  // callbacks would never fire during the await.
  function makeTickCounter() {
    let ticks = 0
    let active = true
    ;(function tick() {
      if (active) {
        ticks++
        setImmediate(tick)
      }
    })()
    return {
      stop() {
        active = false
      },
      get count() {
        return ticks
      }
    }
  }

  test('ffprobe(path) does not block the event loop', async () => {
    const counter = makeTickCounter()
    await ffprobe(TEST_FILE)
    counter.stop()
    assert.ok(counter.count > 0, `event loop ticked ${counter.count} times during ffprobe(path)`)
  })

  test('ffprobe(buffer) does not block the event loop', async () => {
    const buffer = readFileSync(TEST_FILE)
    const counter = makeTickCounter()
    await ffprobe(buffer)
    counter.stop()
    assert.ok(counter.count > 0, `event loop ticked ${counter.count} times during ffprobe(buffer)`)
  })

  test('ffprobe(stream) does not block the event loop', async () => {
    const counter = makeTickCounter()
    await ffprobe(createReadStream(TEST_FILE))
    counter.stop()
    assert.ok(counter.count > 0, `event loop ticked ${counter.count} times during ffprobe(stream)`)
  })
})

describe('API shape', () => {
  test('format has nb_streams, format_name, bit_rate, duration', async () => {
    const r = await ffprobe(TEST_FILE)
    const f = r.format
    assert.ok(f, 'format is present')
    assert.equal(typeof f.nb_streams, 'number')
    assert.equal(typeof f.format_name, 'string')
    assert.ok(f.format_name.length > 0)
    assert.equal(typeof f.duration, 'string')
    assert.equal(typeof f.bit_rate, 'string')
  })

  test('chapters array is present (empty for test file)', async () => {
    const r = await ffprobe(TEST_FILE)
    assert.ok(Array.isArray(r.chapters))
  })

  test('video stream has r_frame_rate, avg_frame_rate, pix_fmt, disposition', async () => {
    const r = await ffprobe(TEST_FILE)
    const v = r.streams.find((s) => s.codec_type === 'video')
    assert.ok(v)
    assert.equal(typeof v.r_frame_rate, 'string')
    assert.ok(v.r_frame_rate.includes('/'), `expected ratio string, got "${v.r_frame_rate}"`)
    assert.equal(typeof v.avg_frame_rate, 'string')
    assert.equal(typeof v.pix_fmt, 'string')
    assert.ok(v.pix_fmt.length > 0)
    assert.equal(typeof v.disposition, 'object')
    assert.equal(typeof v.disposition.default, 'number')
  })

  test('video stream has coded_width, coded_height, time_base', async () => {
    const r = await ffprobe(TEST_FILE)
    const v = r.streams.find((s) => s.codec_type === 'video')
    assert.ok(v)
    assert.equal(typeof v.coded_width, 'number')
    assert.equal(typeof v.coded_height, 'number')
    assert.equal(typeof v.time_base, 'string')
    assert.ok(v.time_base.includes('/'))
  })

  test('audio stream has sample_rate, channels, sample_fmt', async () => {
    const r = await ffprobe(TEST_FILE)
    const a = r.streams.find((s) => s.codec_type === 'audio')
    assert.ok(a)
    assert.equal(typeof a.sample_rate, 'string')
    assert.ok(parseInt(a.sample_rate, 10) > 0)
    assert.ok(typeof a.channels === 'number' && a.channels > 0)
    assert.equal(typeof a.sample_fmt, 'string')
  })

  test('streams have codec_tag_string and index', async () => {
    const r = await ffprobe(TEST_FILE)
    for (const s of r.streams) {
      assert.equal(typeof s.index, 'number')
      assert.equal(typeof s.codec_tag_string, 'string')
      assert.equal(typeof s.codec_long_name, 'string')
    }
  })
})

describe('stream abort and error handling', () => {
  test('stream that errors partway through rejects with an error', async () => {
    const stream = new Readable({read() {}})
    setImmediate(() => {
      stream.push(Buffer.alloc(256))
      stream.destroy(new Error('simulated stream abort after partial data'))
    })
    const err = await isRejected(ffprobe(stream))
    assert.ok(err instanceof Error)
    assert.equal(err.message, 'simulated stream abort after partial data')
  })

  test('stream abort does not hang (completes in reasonable time)', async () => {
    const stream = new Readable({read() {}})
    setTimeout(() => {
      stream.push(Buffer.alloc(512))
      stream.destroy(new Error('abort'))
    }, 10)

    // Should reject quickly, not hang forever
    const err = await isRejected(
      Promise.race([
        ffprobe(stream),
        new Promise((_, reject) =>
          setTimeout(reject, 10000, new Error('timed out — FFmpeg thread likely hung')).unref()
        )
      ])
    )
    assert.ok(err instanceof Error)
    assert.equal(err.message, 'abort')
  })

  test('stream with only invalid/partial data rejects', async () => {
    const stream = new Readable({read() {}})
    setImmediate(() => {
      stream.push(Buffer.from('this is not valid media data at all'))
      stream.push(null) // end without error
    })
    const err = await isRejected(ffprobe(stream))
    assert.ok(err instanceof Error)
    assert.match(err.message, /Invalid data found when processing input/)
  })

  test('stream that sends first 100 bytes of file then errors rejects cleanly', async () => {
    const fileData = readFileSync(TEST_FILE)
    const stream = new Readable({read() {}})
    setImmediate(() => {
      stream.push(fileData.subarray(0, 100))
      stream.destroy(new Error('read limit reached'))
    })
    const err = await isRejected(ffprobe(stream))
    assert.ok(err instanceof Error)
    assert.equal(err.message, 'read limit reached')
  })
})

describe('temp file cleanup', () => {
  let tmpDir

  before(() => {
    tmpDir = mkdtempSync(join(os.tmpdir(), 'ffprobe-test-'))
    process.env.FFPROBE_TMPDIR = tmpDir
  })

  after(() => {
    delete process.env.FFPROBE_TMPDIR
    rmSync(tmpDir, {recursive: true, force: true})
  })

  function listTmpFiles() {
    try {
      return new Set(readdirSync(tmpDir).map((f) => join(tmpDir, f)))
    } catch {
      return new Set()
    }
  }

  test('temp file is deleted after successful stream probe', async () => {
    const before = listTmpFiles()
    await ffprobe(createReadStream(TEST_FILE))
    // Allow any deferred cleanup a tick to complete
    await new Promise((r) => setImmediate(r))
    const after = listTmpFiles()
    const leaked = [...after].filter((f) => !before.has(f))
    assert.deepEqual(leaked, [], `temp files leaked after success: ${leaked.join(', ')}`)
  })

  test('temp file is deleted after stream abort', async () => {
    const before = listTmpFiles()

    const stream = new Readable({read() {}})
    setImmediate(() => {
      stream.push(Buffer.alloc(1024))
      stream.destroy(new Error('abort'))
    })

    await assert.rejects(() => ffprobe(stream))
    await new Promise((r) => setImmediate(r))

    const after = listTmpFiles()
    const leaked = [...after].filter((f) => !before.has(f))
    assert.deepEqual(leaked, [], `temp files leaked after abort: ${leaked.join(', ')}`)
  })

  test('temp file is deleted after stream with partial data', async () => {
    const before = listTmpFiles()

    const stream = new Readable({read() {}})
    setImmediate(() => {
      stream.push(Buffer.from('not media'))
      stream.push(null)
    })

    await assert.rejects(() => ffprobe(stream))
    await new Promise((r) => setImmediate(r))

    const after = listTmpFiles()
    const leaked = [...after].filter((f) => !before.has(f))
    assert.deepEqual(leaked, [], `temp files leaked after partial stream: ${leaked.join(', ')}`)
  })

  // These tests use a >512 KiB file to exercise the disk-spillover path
  test('temp file is deleted after successful stream probe (disk spillover)', async () => {
    const before = listTmpFiles()
    await ffprobe(createReadStream(TEST_FILE_LARGE))
    await new Promise((r) => setImmediate(r))
    const after = listTmpFiles()
    const leaked = [...after].filter((f) => !before.has(f))
    assert.deepEqual(
      leaked,
      [],
      `temp files leaked after success (disk spillover): ${leaked.join(', ')}`
    )
  })

  test('temp file is deleted after stream abort (disk spillover)', async () => {
    const before = listTmpFiles()

    // Push >512 KiB to trigger spillover, then abort
    const stream = new Readable({read() {}})
    setImmediate(() => {
      stream.push(Buffer.alloc(600 * 1024))
      stream.destroy(new Error('abort'))
    })

    await assert.rejects(() => ffprobe(stream))
    await new Promise((r) => setImmediate(r))

    const after = listTmpFiles()
    const leaked = [...after].filter((f) => !before.has(f))
    assert.deepEqual(
      leaked,
      [],
      `temp files leaked after abort (disk spillover): ${leaked.join(', ')}`
    )
  })

  test('temp file is deleted after successful stream probe (disk spillover, moov at end)', async () => {
    const before = listTmpFiles()
    const result = await ffprobe(createReadStream(TEST_FILE_LARGE_NO_FASTSTART))
    assert.ok(Array.isArray(result.streams))
    await new Promise((r) => setImmediate(r))
    const after = listTmpFiles()
    const leaked = [...after].filter((f) => !before.has(f))
    assert.deepEqual(
      leaked,
      [],
      `temp files leaked after probe (disk spillover, moov at end): ${leaked.join(', ')}`
    )
  })
})

describe('Web ReadableStream', () => {
  test('accepts a Web ReadableStream directly', async () => {
    const webStream = new ReadableStream({
      start(controller) {
        controller.enqueue(readFileSync(TEST_FILE))
        controller.close()
      }
    })
    const r = await ffprobe(webStream)
    assert.ok(Array.isArray(r.streams))
    assert.equal(r.streams.length, 2)
    const v = r.streams.find((s) => s.codec_type === 'video')
    assert.equal(v.width, 64)
    assert.equal(v.height, 64)
  })

  test('accepts Uint8Array chunks (fetch body scenario)', async () => {
    // fetch() response bodies yield Uint8Array, not Buffer. This is the real-world
    // case that triggered the "Failed to get Buffer pointer and length" error.
    const fileData = readFileSync(TEST_FILE)
    const webStream = new ReadableStream({
      start(controller) {
        // Enqueue as plain Uint8Array, same as a fetch response body would
        controller.enqueue(new Uint8Array(fileData.buffer, fileData.byteOffset, fileData.byteLength))
        controller.close()
      }
    })
    const r = await ffprobe(webStream)
    assert.ok(Array.isArray(r.streams))
    assert.equal(r.streams.length, 2)
  })

  test('Web ReadableStream error is propagated as rejection', async () => {
    const webStream = new ReadableStream({
      start(controller) {
        controller.enqueue(Buffer.from('not media'))
        controller.error(new Error('web stream error'))
      }
    })
    const err = await isRejected(ffprobe(webStream))
    assert.ok(err instanceof Error)
    assert.equal(err.message, 'web stream error')
  })
})

describe('format coverage', () => {
  const formats = [
    // Audio-only files
    {file: 'test_audio.mp3', streams: [{codec_type: 'audio', codec_name: 'mp3'}]},
    {file: 'test_audio.m4a', streams: [{codec_type: 'audio', codec_name: 'aac'}]},
    {file: 'test_audio.flac', streams: [{codec_type: 'audio', codec_name: 'flac'}]},
    {file: 'test_audio.wav', streams: [{codec_type: 'audio', codec_name: 'pcm_s16le'}]},
    {file: 'test_audio.opus', streams: [{codec_type: 'audio', codec_name: 'opus'}]},
    // Video-only
    {file: 'test_video_only.mp4', streams: [{codec_type: 'video', codec_name: 'h264'}]},
    // Video + audio in various containers/codecs
    {
      file: 'test_hevc.mp4',
      streams: [
        {codec_type: 'video', codec_name: 'hevc'},
        {codec_type: 'audio', codec_name: 'aac'}
      ]
    },
    {
      file: 'test_vp8.webm',
      streams: [
        {codec_type: 'video', codec_name: 'vp8'},
        {codec_type: 'audio', codec_name: 'opus'}
      ]
    },
    {
      file: 'test_vp9.webm',
      streams: [
        {codec_type: 'video', codec_name: 'vp9'},
        {codec_type: 'audio', codec_name: 'opus'}
      ]
    },
    {
      file: 'test_mkv.mkv',
      streams: [
        {codec_type: 'video', codec_name: 'h264'},
        {codec_type: 'audio', codec_name: 'aac'}
      ]
    },
    {
      file: 'test_multitrack.mkv',
      streams: [
        {codec_type: 'video', codec_name: 'h264'},
        {codec_type: 'audio', codec_name: 'aac'},
        {codec_type: 'audio', codec_name: 'aac'}
      ]
    },
    {
      file: 'test_subtitles.mkv',
      streams: [
        {codec_type: 'video', codec_name: 'h264'},
        {
          codec_type: 'audio',
          codec_name: 'aac',
          tags: {
            DURATION: '00:00:01.023000000',
            ENCODER: 'Lavc62.11.100 aac',
            language: 'eng'
          }
        },
        {
          codec_type: 'audio',
          codec_name: 'aac',
          tags: {
            DURATION: '00:00:01.023000000',
            ENCODER: 'Lavc62.11.100 aac',
            language: 'fre'
          }
        },
        {
          codec_type: 'subtitle',
          codec_name: 'subrip',
          tags: {
            DURATION: '00:00:01.000000000',
            ENCODER: 'Lavc62.11.100 srt',
            language: 'eng'
          }
        }
      ]
    },
    {
      file: 'test_chapters.mkv',
      streams: [
        {codec_type: 'video', codec_name: 'h264'},
        {codec_type: 'audio', codec_name: 'aac'}
      ],
      chapters: [
        {id: 1, title: 'Intro', start_time: '0.000000', end_time: '1.000000'},
        {id: 2, title: 'Main', start_time: '1.000000', end_time: '2.000000'},
        {id: 3, title: 'Outro', start_time: '2.000000', end_time: '3.000000'}
      ]
    }
  ]

  for (const {file, streams, chapters} of formats) {
    test(`probes ${file} correctly`, async () => {
      const r = await ffprobe(join(testData, file))
      assert.ok(Array.isArray(r.streams), 'streams is array')
      assert.equal(r.streams.length, streams.length, `expected ${streams.length} streams`)
      for (let i = 0; i < streams.length; i++) {
        assert.partialDeepStrictEqual(r.streams[i], streams[i])
      }
      if (chapters) {
        assert.equal(r.chapters.length, chapters.length, `expected ${chapters.length} chapters`)
        for (let i = 0; i < chapters.length; i++) {
          assert.partialDeepStrictEqual(r.chapters[i], {
            id: chapters[i].id,
            start_time: chapters[i].start_time,
            end_time: chapters[i].end_time,
            tags: {title: chapters[i].title}
          })
        }
      }
      const dur = parseFloat(r.format.duration)
      assert.ok(dur > 0.5, `expected duration > 0.5s, got ${dur}`)
    })
  }
})

const SNAPSHOT_MEDIA_EXTENSIONS = new Set([
  '.mp4',
  '.mkv',
  '.webm',
  '.mp3',
  '.m4a',
  '.flac',
  '.wav',
  '.opus'
])

describe('snapshots', () => {
  const snapshotFiles = readdirSync(testData).filter((f) => f.endsWith('.json'))

  for (const snapshotFile of snapshotFiles) {
    const mediaFile = snapshotFile.slice(0, -5) // strip .json
    if (!SNAPSHOT_MEDIA_EXTENSIONS.has(extname(mediaFile))) continue

    test(`snapshot matches for ${mediaFile}`, async () => {
      const expected = JSON.parse(readFileSync(join(testData, snapshotFile), 'utf8'))
      const actual = await ffprobe(join(testData, mediaFile))
      assert.deepEqual(actual, expected)
    })
  }
})

describe('concurrent requests', () => {
  test('multiple simultaneous probes of small files', async () => {
    const file = TEST_FILE
    const result = await allEqual(
      ffprobe(file),
      ffprobe(file),
      ffprobe(file),
      ffprobe(readFileSync(file)),
      ffprobe(readFileSync(file)),
      ffprobe(readFileSync(file)),
      ffprobe(createReadStream(file)),
      ffprobe(createReadStream(file)),
      ffprobe(createReadStream(file))
    )

    assert.equal(result.streams.length, 2)
    const v = result.streams.find((s) => s.codec_type === 'video')
    assert.equal(v.width, 64)
    assert.equal(v.height, 64)
    assert.equal(v.codec_name, 'h264')
  })

  test('multiple simultaneous probes of bigger files', async () => {
    const file = TEST_FILE_LARGE_NO_FASTSTART
    const result = await allEqual(
      ffprobe(file),
      ffprobe(file),
      ffprobe(file),
      ffprobe(readFileSync(file)),
      ffprobe(readFileSync(file)),
      ffprobe(readFileSync(file)),
      ffprobe(createReadStream(file)),
      ffprobe(createReadStream(file)),
      ffprobe(createReadStream(file)),
      ffprobe(Readable.toWeb(createReadStream(file))),
      ffprobe(Readable.toWeb(createReadStream(file))),
      ffprobe(Readable.toWeb(createReadStream(file)))
    )

    assert.equal(result.streams.length, 2)
    const v = result.streams.find((s) => s.codec_type === 'video')
    assert.equal(v.codec_name, 'h264')
    assert.equal(v.width, 1920)
    assert.equal(v.height, 1080)
  })
})
