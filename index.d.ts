import type { Readable } from 'stream'

export interface StreamDisposition {
  default: number
  dub: number
  original: number
  comment: number
  lyrics: number
  karaoke: number
  forced: number
  hearing_impaired: number
  visual_impaired: number
  clean_effects: number
  attached_pic: number
  timed_thumbnails: number
}

export interface StreamInfo {
  index: number
  codec_name?: string
  codec_long_name?: string
  profile?: string
  codec_type?: string
  codec_tag_string?: string
  codec_tag?: string
  // video-specific
  width?: number
  height?: number
  coded_width?: number
  coded_height?: number
  pix_fmt?: string
  color_range?: string
  color_space?: string
  color_transfer?: string
  color_primaries?: string
  // video frame rate
  r_frame_rate?: string
  avg_frame_rate?: string
  // audio-specific
  sample_fmt?: string
  sample_rate?: string
  channels?: number
  channel_layout?: string
  bits_per_sample?: number
  // common timing
  time_base?: string
  start_pts?: number
  start_time?: string
  duration_ts?: number
  duration?: string
  bit_rate?: string
  nb_frames?: string
  disposition?: StreamDisposition
  tags?: Record<string, string>
  [key: string]: unknown
}

export interface FormatInfo {
  filename?: string
  nb_streams?: number
  nb_programs?: number
  format_name?: string
  format_long_name?: string
  start_time?: string
  duration?: string
  size?: string
  bit_rate?: string
  probe_score?: number
  tags?: Record<string, string>
  [key: string]: unknown
}

export interface ChapterInfo {
  id?: number
  time_base?: string
  start?: number
  start_time?: string
  end?: number
  end_time?: string
  tags?: Record<string, string>
  [key: string]: unknown
}

export interface ProbeResult {
  streams: StreamInfo[]
  format?: FormatInfo
  chapters?: ChapterInfo[]
  [key: string]: unknown
}

/**
 * Probe a media file by path, Buffer/Uint8Array, Node.js Readable, or Web ReadableStream.
 * Does not block the Node.js event loop.
 */
export default function ffprobe(
  input: string | Buffer | Uint8Array | Readable | ReadableStream
): Promise<ProbeResult>
