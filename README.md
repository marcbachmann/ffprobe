# @marcbachmann/ffprobe

Non-blocking Node.js native bindings for `ffprobe`. FFmpeg is statically linked into the `.node` binary — no system `ffprobe` binary needed, no postInstall scripts, no binary downloads at install time.

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

## License

MIT
