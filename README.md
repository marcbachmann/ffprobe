# @marcbachmann/ffprobe

- **No postInstall scripts** — installation is a plain file copy, nothing executes
- **No binary downloads** — FFmpeg is statically linked into the `.node` addon; works in air-gapped environments and behind corporate proxies
- **Non-blocking** — probing runs inside a Rust thread pool, the Node.js event loop stays free
- **No subprocess overhead** — FFmpeg runs in-process, no `child_process.spawn` per call
- **No system `ffprobe` required** — fully self-contained

## Platform support

| Platform | Package |
|---|---|
| macOS x64 | `@marcbachmann/ffprobe-darwin-x64` |
| macOS arm64 (Apple Silicon) | `@marcbachmann/ffprobe-darwin-arm64` |
| Linux x64 (glibc) | `@marcbachmann/ffprobe-linux-x64-gnu` |
| Linux arm64 (glibc) | `@marcbachmann/ffprobe-linux-arm64-gnu` |
| Linux x64 (musl / Alpine) | `@marcbachmann/ffprobe-linux-x64-musl` |
| Linux arm64 (musl / Alpine) | `@marcbachmann/ffprobe-linux-arm64-musl` |
| Windows x64 | `@marcbachmann/ffprobe-win32-x64-msvc` |

The platform packages are installed automatically as `optionalDependencies`.

## Install

```sh
npm install @marcbachmann/ffprobe
```

## Usage

```js
const ffprobe = require('@marcbachmann/ffprobe')

// File path
const result = await ffprobe('/path/to/video.mp4')

// Buffer / Uint8Array (no temp file — FFmpeg reads directly from memory)
const result = await ffprobe(fs.readFileSync('/path/to/video.mp4'))

// Node.js Readable stream
const result = await ffprobe(fs.createReadStream('/path/to/video.mp4'))

// Web ReadableStream
const result = await ffprobe(response.body)
```

`ffprobe` returns a `Promise<ProbeResult>` and never blocks the event loop.

## Result shape

```ts
interface ProbeResult {
  streams: StreamInfo[]   // video, audio, subtitle tracks
  format?: FormatInfo     // container info: duration, bit_rate, format_name, …
  chapters?: ChapterInfo[]
}
```

See [index.d.ts](index.d.ts) for the full type definitions.

## Environment variables

| Variable | Description |
|---|---|
| `FFPROBE_TMPDIR` | Directory used for spill files during stream probing (see below). Defaults to the OS temp directory. |

### Stream spilling

When probing a Readable or Web ReadableStream, incoming bytes are buffered in memory
up to 512 KiB. If the stream exceeds that threshold, data spills to a temporary file
so that FFmpeg can seek backwards — required for formats like MP4 that store their
metadata (moov atom) at the end of the file. The temp file is deleted as soon as
probing completes.

Set `FFPROBE_TMPDIR` to control where spill files are written, for example to keep
them on a fast local disk or an in-memory filesystem (`/dev/shm` on Linux).

## License

MIT
