use std::ffi::{c_char, CStr};

use ffmpeg_next::ffi::{
  av_bprint_finalize, av_bprint_init, av_channel_layout_describe, av_get_bits_per_sample,
  av_get_sample_fmt_name, av_mime_codec_str, av_reduce, avcodec_descriptor_get,
  avcodec_profile_name, avio_size, AVBPrint, AVRational,
};
use ffmpeg_next::format::context::Input;
use ffmpeg_next::media;
use serde_json::{json, Map, Value};

const AV_NOPTS_VALUE: i64 = i64::MIN;
const AV_TIME_BASE: i64 = 1_000_000;
const AV_PROFILE_UNKNOWN: i32 = -99;

// AV_DISPOSITION_* bit flags not exposed by ffmpeg_next's Disposition bitflags type
const AV_DISPOSITION_TIMED_THUMBNAILS: i32 = 0x0000_0800;
const AV_DISPOSITION_NON_DIEGETIC: i32 = 0x0000_1000;
const AV_DISPOSITION_DEPENDENT: i32 = 0x0008_0000;
const AV_DISPOSITION_STILL_IMAGE: i32 = 0x0010_0000;

// ── Safe wrappers around FFmpeg FFI calls ─────────────────────────────────────

fn codec_long_name(id: ffmpeg_next::codec::Id) -> String {
  // SAFETY: avcodec_descriptor_get returns a static pointer or NULL; we check
  // for NULL before dereferencing.
  unsafe {
    let desc = avcodec_descriptor_get(id.into());
    if desc.is_null() {
      return String::new();
    }
    let long_name = (*desc).long_name;
    if long_name.is_null() {
      return String::new();
    }
    CStr::from_ptr(long_name).to_string_lossy().into_owned()
  }
}

fn codec_profile_name(id: ffmpeg_next::codec::Id, profile: i32) -> Option<String> {
  if profile == AV_PROFILE_UNKNOWN {
    return None;
  }
  // SAFETY: avcodec_profile_name returns a static string pointer or NULL.
  unsafe {
    let ptr = avcodec_profile_name(id.into(), profile);
    if ptr.is_null() {
      // No named profile — fall back to numeric string, matching ffprobe.
      Some(profile.to_string())
    } else {
      Some(CStr::from_ptr(ptr).to_string_lossy().into_owned())
    }
  }
}

fn pixel_format_name(fmt: i32) -> String {
  // SAFETY: transmute from i32 to AVPixelFormat is valid because AVPixelFormat
  // is repr(C) and defined as a signed 32-bit integer in FFmpeg's headers.
  let pixel = unsafe {
    ffmpeg_next::util::format::Pixel::from(std::mem::transmute::<
      i32,
      ffmpeg_next::ffi::AVPixelFormat,
    >(fmt))
  };
  pixel
    .descriptor()
    .map(|d| d.name().to_owned())
    .unwrap_or_default()
}

fn sample_format_name(fmt: i32) -> String {
  // SAFETY: same repr as AVSampleFormat; av_get_sample_fmt_name returns a
  // static string or NULL.
  unsafe {
    let ptr =
      av_get_sample_fmt_name(std::mem::transmute::<i32, ffmpeg_next::ffi::AVSampleFormat>(fmt));
    if ptr.is_null() {
      "unknown".to_owned()
    } else {
      CStr::from_ptr(ptr).to_str().unwrap_or("unknown").to_owned()
    }
  }
}

/// Returns the codec's fixed bits-per-sample (e.g. 16 for PCM s16le), or 0
/// for codecs with variable/compressed bit depth (AAC, MP3, Opus, …).
/// Matches what ffprobe outputs for `bits_per_sample`.
fn codec_bits_per_sample(id: ffmpeg_next::codec::Id) -> i32 {
  // SAFETY: pure computation, no pointer dereference.
  unsafe { av_get_bits_per_sample(id.into()) }
}

fn channel_layout_description(layout: &ffmpeg_next::ffi::AVChannelLayout) -> Option<String> {
  // SAFETY: av_channel_layout_describe writes into our buffer and returns the
  // number of bytes written (> 0) or an error code (≤ 0).
  unsafe {
    let mut buf = vec![0u8; 64];
    let ret = av_channel_layout_describe(
      layout as *const _,
      buf.as_mut_ptr() as *mut c_char,
      buf.len(),
    );
    if ret > 0 {
      let end = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
      String::from_utf8(buf[..end].to_vec()).ok()
    } else {
      None
    }
  }
}

/// Returns the RFC 4281/6381 MIME codec string (e.g. "avc1.f4000a", "mp4a.40.2")
/// for the given codec parameters and frame rate.  Returns `None` if FFmpeg
/// returns an error or an empty string.
fn mime_codec_string(
  codecpar: &ffmpeg_next::ffi::AVCodecParameters,
  frame_rate: ffmpeg_next::Rational,
) -> Option<String> {
  // SAFETY: AVBPrint contains a self-referential pointer (str_ → reserved_
  // internal_buffer within the same struct), so the struct must never be
  // moved after av_bprint_init.  We keep it in a MaybeUninit slot and only
  // ever access it through a raw pointer.
  unsafe {
    let mut bp = std::mem::MaybeUninit::<AVBPrint>::uninit();
    // AV_BPRINT_SIZE_AUTOMATIC = 1: use the internal buffer so no heap
    // allocation is needed for the short strings av_mime_codec_str produces.
    av_bprint_init(bp.as_mut_ptr(), 0, 1);
    let bp_ptr = bp.as_mut_ptr();
    let fr = AVRational {
      num: frame_rate.numerator(),
      den: frame_rate.denominator(),
    };
    let ret = av_mime_codec_str(codecpar as *const _, fr, bp_ptr);
    if ret < 0 || (*bp_ptr).len == 0 {
      av_bprint_finalize(bp_ptr, std::ptr::null_mut());
      return None;
    }
    // (*bp_ptr).str_ points to the internal buffer (or heap if the string
    // was truncated), and is always NUL-terminated.
    let result = CStr::from_ptr((*bp_ptr).str_)
      .to_str()
      .ok()
      .filter(|s| !s.is_empty())
      .map(|s| s.to_owned());
    av_bprint_finalize(bp_ptr, std::ptr::null_mut());
    result
  }
}

/// Compute the display aspect ratio string ("W:H") from coded dimensions and
/// the sample aspect ratio, using FFmpeg's `av_reduce` for simplification.
fn display_aspect_ratio(width: i32, height: i32, sar_num: i32, sar_den: i32) -> String {
  let mut dar_num: i32 = 0;
  let mut dar_den: i32 = 0;
  if sar_num > 0 && sar_den > 0 {
    // SAFETY: av_reduce takes mutable i32 pointers and an i64 max; all
    // values are valid.
    unsafe {
      av_reduce(
        &mut dar_num,
        &mut dar_den,
        (width as i64) * (sar_num as i64),
        (height as i64) * (sar_den as i64),
        1024 * 1024,
      );
    }
  } else {
    let g = gcd(width.unsigned_abs() as u64, height.unsigned_abs() as u64) as i32;
    if g > 0 {
      dar_num = width / g;
      dar_den = height / g;
    }
  }
  format!("{}:{}", dar_num, dar_den)
}

fn format_io_size(pb: *mut ffmpeg_next::ffi::AVIOContext) -> i64 {
  if pb.is_null() {
    return -1;
  }
  // SAFETY: pb is non-null and owned by the AVFormatContext we borrowed.
  unsafe { avio_size(pb) }
}

// ── Pure helpers ──────────────────────────────────────────────────────────────

/// Render a codec tag u32 as a 4-char FourCC string, matching ffprobe's output:
/// printable ASCII (0x20–0x7e) is kept; other bytes are rendered as `[N]`
/// (e.g. tag bytes 0x01 0x00 0x00 0x00 → `"[1][0][0][0]"`).
fn codec_tag_string(tag: u32) -> String {
  let bytes = tag.to_le_bytes();
  let mut result = String::with_capacity(16);
  for &b in &bytes {
    if b >= 0x20 && b < 0x7f {
      result.push(b as char);
    } else {
      use std::fmt::Write;
      write!(result, "[{}]", b).unwrap();
    }
  }
  result
}

fn rational_to_string(r: ffmpeg_next::Rational) -> String {
  format!("{}/{}", r.numerator(), r.denominator())
}

fn pts_to_time_str(pts: i64, time_base: ffmpeg_next::Rational) -> Option<String> {
  if pts == AV_NOPTS_VALUE {
    return None;
  }
  let secs = pts as f64 * time_base.numerator() as f64 / time_base.denominator() as f64;
  Some(format!("{:.6}", secs))
}

fn media_type_str(medium: media::Type) -> &'static str {
  match medium {
    media::Type::Video => "video",
    media::Type::Audio => "audio",
    media::Type::Subtitle => "subtitle",
    media::Type::Data => "data",
    media::Type::Attachment => "attachment",
    _ => "unknown",
  }
}

fn field_order_str(fo: u32) -> &'static str {
  match fo {
    1 => "progressive",
    2 => "tt",
    3 => "bb",
    4 => "tb",
    5 => "bt",
    _ => "unknown",
  }
}

fn chroma_location_str(cl: u32) -> &'static str {
  match cl {
    1 => "left",
    2 => "center",
    3 => "topleft",
    4 => "top",
    5 => "bottomleft",
    6 => "bottom",
    _ => "unspecified",
  }
}

fn build_disposition(bits: i32) -> Value {
  use ffmpeg_next::format::stream::Disposition;
  let d = Disposition::from_bits_truncate(bits);
  let flag = |f: Disposition| -> i32 { i32::from(d.contains(f)) };
  let raw = |mask: i32| -> i32 { i32::from(bits & mask != 0) };
  json!({
      "default":          flag(Disposition::DEFAULT),
      "dub":              flag(Disposition::DUB),
      "original":         flag(Disposition::ORIGINAL),
      "comment":          flag(Disposition::COMMENT),
      "lyrics":           flag(Disposition::LYRICS),
      "karaoke":          flag(Disposition::KARAOKE),
      "forced":           flag(Disposition::FORCED),
      "hearing_impaired": flag(Disposition::HEARING_IMPAIRED),
      "visual_impaired":  flag(Disposition::VISUAL_IMPAIRED),
      "clean_effects":    flag(Disposition::CLEAN_EFFECTS),
      "attached_pic":     flag(Disposition::ATTACHED_PIC),
      "timed_thumbnails": raw(AV_DISPOSITION_TIMED_THUMBNAILS),
      "non_diegetic":     raw(AV_DISPOSITION_NON_DIEGETIC),
      "captions":         flag(Disposition::CAPTIONS),
      "descriptions":     flag(Disposition::DESCRIPTIONS),
      "metadata":         flag(Disposition::METADATA),
      "dependent":        raw(AV_DISPOSITION_DEPENDENT),
      "still_image":      raw(AV_DISPOSITION_STILL_IMAGE),
      "multilayer":       flag(Disposition::MULTILAYER),
  })
}

fn build_tags(metadata: ffmpeg_next::DictionaryRef<'_>) -> Option<Value> {
  let mut map = Map::new();
  for (key, value) in metadata.iter() {
    map.insert(key.to_owned(), Value::String(value.to_owned()));
  }
  if map.is_empty() {
    None
  } else {
    Some(Value::Object(map))
  }
}

fn gcd(mut a: u64, mut b: u64) -> u64 {
  while b != 0 {
    let t = b;
    b = a % b;
    a = t;
  }
  a
}

// ── Public entry point ────────────────────────────────────────────────────────

pub fn probe(ctx: &Input) -> napi::Result<Value> {
  let mut streams_json = Vec::new();

  for stream in ctx.streams() {
    let params = stream.parameters();
    let medium = params.medium();
    let codec_id = params.id();

    // SAFETY: params and stream are valid for the duration of this loop body;
    // we do not store the raw references beyond this scope.
    let (codecpar, stream_id) = unsafe { (&*params.as_ptr(), (*stream.as_ptr()).id) };

    let codec_name = codec_id.name().to_owned();
    let bit_rate = codecpar.bit_rate;
    let extradata_size = codecpar.extradata_size;
    let time_base = stream.time_base();
    let start_pts = stream.start_time();
    let duration_ts = stream.duration();
    let nb_frames = stream.frames();
    // stream.disposition().bits() avoids a raw pointer dereference for this field.
    let disposition_bits = stream.disposition().bits();

    let mut s = Map::new();
    s.insert("index".into(), json!(stream.index()));
    s.insert("codec_name".into(), json!(codec_name));
    s.insert("codec_long_name".into(), json!(codec_long_name(codec_id)));
    if let Some(p) = codec_profile_name(codec_id, codecpar.profile) {
      s.insert("profile".into(), json!(p));
    }
    s.insert("codec_type".into(), json!(media_type_str(medium)));
    s.insert(
      "codec_tag_string".into(),
      json!(codec_tag_string(codecpar.codec_tag)),
    );
    s.insert(
      "codec_tag".into(),
      json!(format!("0x{:04x}", codecpar.codec_tag)),
    );
    if let Some(mcs) = mime_codec_string(codecpar, stream.avg_frame_rate()) {
      s.insert("mime_codec_string".into(), json!(mcs));
    }

    // Media-type-specific fields (match ffprobe's field ordering)
    match medium {
      media::Type::Video => {
        let width = codecpar.width;
        let height = codecpar.height;
        let sar = codecpar.sample_aspect_ratio;
        let level = codecpar.level;
        let field_order = codecpar.field_order as u32;
        let chroma_loc = codecpar.chroma_location as u32;

        let color_range = ffmpeg_next::util::color::Range::from(codecpar.color_range);
        let color_space = ffmpeg_next::util::color::Space::from(codecpar.color_space);
        let color_transfer =
          ffmpeg_next::util::color::TransferCharacteristic::from(codecpar.color_trc);
        let color_primaries = ffmpeg_next::util::color::Primaries::from(codecpar.color_primaries);

        s.insert("width".into(), json!(width));
        s.insert("height".into(), json!(height));
        s.insert("coded_width".into(), json!(width));
        s.insert("coded_height".into(), json!(height));
        s.insert(
          "sample_aspect_ratio".into(),
          json!(format!("{}:{}", sar.num, sar.den)),
        );
        s.insert(
          "display_aspect_ratio".into(),
          json!(display_aspect_ratio(width, height, sar.num, sar.den)),
        );
        s.insert("pix_fmt".into(), json!(pixel_format_name(codecpar.format)));
        s.insert("level".into(), json!(level));
        if let Some(name) = color_range.name().filter(|&n| n != "unknown") {
          s.insert("color_range".into(), json!(name));
        }
        if let Some(name) = color_space.name().filter(|&n| n != "unspecified") {
          s.insert("color_space".into(), json!(name));
        }
        if let Some(name) = color_transfer.name().filter(|&n| n != "unspecified") {
          s.insert("color_transfer".into(), json!(name));
        }
        if let Some(name) = color_primaries.name().filter(|&n| n != "unspecified") {
          s.insert("color_primaries".into(), json!(name));
        }
        if chroma_loc != 0 {
          s.insert(
            "chroma_location".into(),
            json!(chroma_location_str(chroma_loc)),
          );
        }
        s.insert("field_order".into(), json!(field_order_str(field_order)));
      }
      media::Type::Audio => {
        let ch_layout = ffmpeg_next::ChannelLayout::from(codecpar.ch_layout);
        s.insert(
          "sample_fmt".into(),
          json!(sample_format_name(codecpar.format)),
        );
        s.insert(
          "sample_rate".into(),
          json!(codecpar.sample_rate.to_string()),
        );
        s.insert("channels".into(), json!(ch_layout.channels()));
        // Only include channel_layout when it's a named layout (e.g. "mono",
        // "stereo"). Unnamed layouts like "1 channels" are not included by
        // the official ffprobe CLI.
        if let Some(cl) = channel_layout_description(&codecpar.ch_layout) {
          if !cl.ends_with(" channels") {
            s.insert("channel_layout".into(), json!(cl));
          }
        }
        s.insert(
          "bits_per_sample".into(),
          json!(codec_bits_per_sample(codec_id)),
        );
        s.insert("initial_padding".into(), json!(codecpar.initial_padding));
      }
      _ => {}
    }

    // bits_per_raw_sample: applies to lossless audio (FLAC, PCM) and video alike.
    let bits_per_raw = codecpar.bits_per_raw_sample;
    if bits_per_raw > 0 {
      s.insert(
        "bits_per_raw_sample".into(),
        json!(bits_per_raw.to_string()),
      );
    }

    // Common timing & metadata fields (match ffprobe's output order)
    if stream_id != 0 {
      s.insert("id".into(), json!(format!("0x{:x}", stream_id)));
    }
    s.insert(
      "r_frame_rate".into(),
      json!(rational_to_string(stream.rate())),
    );
    s.insert(
      "avg_frame_rate".into(),
      json!(rational_to_string(stream.avg_frame_rate())),
    );
    s.insert("time_base".into(), json!(rational_to_string(time_base)));
    if start_pts != AV_NOPTS_VALUE {
      s.insert("start_pts".into(), json!(start_pts));
      if let Some(t) = pts_to_time_str(start_pts, time_base) {
        s.insert("start_time".into(), json!(t));
      }
    }
    if duration_ts != AV_NOPTS_VALUE {
      s.insert("duration_ts".into(), json!(duration_ts));
      if let Some(t) = pts_to_time_str(duration_ts, time_base) {
        s.insert("duration".into(), json!(t));
      }
    }
    if bit_rate > 0 {
      s.insert("bit_rate".into(), json!(bit_rate.to_string()));
    }
    if nb_frames > 0 {
      s.insert("nb_frames".into(), json!(nb_frames.to_string()));
    }
    if extradata_size > 0 {
      s.insert("extradata_size".into(), json!(extradata_size));
    }
    s.insert("disposition".into(), build_disposition(disposition_bits));
    if let Some(tags) = build_tags(stream.metadata()) {
      s.insert("tags".into(), tags);
    }

    streams_json.push(Value::Object(s));
  }

  // ── Format ────────────────────────────────────────────────────────────────

  // SAFETY: ctx is a valid AVFormatContext for the duration of this call.
  let fmt_ctx_raw = unsafe { &*ctx.as_ptr() };

  let fmt = ctx.format();
  let ctx_duration = ctx.duration();
  let ctx_bit_rate = ctx.bit_rate();

  let duration_str = if ctx_duration == AV_NOPTS_VALUE || ctx_duration < 0 {
    Value::Null
  } else {
    Value::String(format!("{:.6}", ctx_duration as f64 / AV_TIME_BASE as f64))
  };

  let fmt_start_time = fmt_ctx_raw.start_time;
  let start_time_str = if fmt_start_time != AV_NOPTS_VALUE {
    Some(format!(
      "{:.6}",
      fmt_start_time as f64 / AV_TIME_BASE as f64
    ))
  } else {
    None
  };

  let size = format_io_size(fmt_ctx_raw.pb);

  let mut format_json = Map::new();
  format_json.insert("nb_streams".into(), json!(ctx.nb_streams()));
  format_json.insert("nb_programs".into(), json!(fmt_ctx_raw.nb_programs));
  format_json.insert(
    "nb_stream_groups".into(),
    json!(fmt_ctx_raw.nb_stream_groups),
  );
  format_json.insert("format_name".into(), json!(fmt.name()));
  format_json.insert("format_long_name".into(), json!(fmt.description()));
  if let Some(t) = start_time_str {
    format_json.insert("start_time".into(), json!(t));
  }
  format_json.insert("duration".into(), duration_str);
  if size > 0 {
    format_json.insert("size".into(), json!(size.to_string()));
  }
  if ctx_bit_rate > 0 {
    format_json.insert("bit_rate".into(), json!(ctx_bit_rate.to_string()));
  }
  format_json.insert("probe_score".into(), json!(fmt_ctx_raw.probe_score));
  if let Some(tags) = build_tags(ctx.metadata()) {
    format_json.insert("tags".into(), tags);
  }

  // ── Chapters ──────────────────────────────────────────────────────────────

  let chapters_json: Vec<Value> = ctx
    .chapters()
    .map(|ch| {
      let tb = ch.time_base();
      let start = ch.start();
      let end = ch.end();
      let mut c = Map::new();
      c.insert("id".into(), json!(ch.id()));
      c.insert("time_base".into(), json!(rational_to_string(tb)));
      c.insert("start".into(), json!(start));
      if let Some(t) = pts_to_time_str(start, tb) {
        c.insert("start_time".into(), json!(t));
      }
      c.insert("end".into(), json!(end));
      if let Some(t) = pts_to_time_str(end, tb) {
        c.insert("end_time".into(), json!(t));
      }
      if let Some(tags) = build_tags(ch.metadata()) {
        c.insert("tags".into(), tags);
      }
      Value::Object(c)
    })
    .collect();

  Ok(json!({
      "streams": streams_json,
      "chapters": chapters_json,
      "format": Value::Object(format_json),
  }))
}

#[cfg(test)]
mod tests {
  use super::*;

  fn open_test_file() -> ffmpeg_next::format::context::Input {
    ffmpeg_next::init().unwrap();
    let manifest = std::env::var("CARGO_MANIFEST_DIR").unwrap();
    let path = format!("{}/test/test_data/test.mp4", manifest);
    ffmpeg_next::format::input(&path).expect("test_data/test.mp4 must exist")
  }

  #[test]
  fn probe_returns_video_stream() {
    let ctx = open_test_file();
    let result = probe(&ctx).unwrap();
    let streams = result["streams"].as_array().unwrap();
    let video = streams.iter().find(|s| s["codec_type"] == "video").unwrap();
    assert_eq!(video["width"], 64);
    assert_eq!(video["height"], 64);
    assert_eq!(video["codec_name"], "h264");
  }

  #[test]
  fn probe_returns_audio_stream() {
    let ctx = open_test_file();
    let result = probe(&ctx).unwrap();
    let streams = result["streams"].as_array().unwrap();
    let audio = streams.iter().find(|s| s["codec_type"] == "audio").unwrap();
    assert_eq!(audio["codec_name"], "aac");
  }

  #[test]
  fn probe_returns_format_with_duration() {
    let ctx = open_test_file();
    let result = probe(&ctx).unwrap();
    let duration: f64 = result["format"]["duration"]
      .as_str()
      .unwrap()
      .parse()
      .unwrap();
    assert!(
      duration > 0.5 && duration < 2.0,
      "duration should be ~1s, got {}",
      duration
    );
  }
}
