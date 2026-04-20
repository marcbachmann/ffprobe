#![deny(clippy::all)]
pub mod probe;
mod streaming_file;

use std::io::Cursor;
use std::io::Write;
use std::sync::{Arc, Condvar, Mutex};

use napi::bindgen_prelude::*;
use napi_derive::napi;

use streaming_file::{StreamingFile, WriteState};

fn init_ffmpeg() {
  static ONCE: std::sync::OnceLock<()> = std::sync::OnceLock::new();
  ONCE.get_or_init(|| {
    ffmpeg_next::init().expect("ffmpeg init failed");
    ffmpeg_next::util::log::set_level(ffmpeg_next::util::log::Level::Fatal);
  });
}

/// 512 KiB threshold: covers front-loaded format headers without
/// touching disk in the common case.
const IN_MEM_THRESHOLD: u64 = 512 * 1024;

/// Unified probe task.
///
/// - Static methods `probeFile` and `probeBuffer` handle the simple cases.
/// - For streams, JS creates an instance, calls `start()`, pushes chunks
///   via `push()`, then `finish()`.  Chunks flow through a bounded
///   `tokio::sync::mpsc` channel to a write loop on tokio, providing
///   backpressure without blocking the JS thread.
#[napi]
pub struct ProbeTask {
  tx: Option<tokio::sync::mpsc::Sender<Vec<u8>>>,
}

#[napi]
impl ProbeTask {
  #[napi(constructor)]
  pub fn new() -> Self {
    Self { tx: None }
  }

  /// Probe a media file by path.
  #[napi]
  pub async fn probe_file(path: String) -> Result<serde_json::Value> {
    tokio::task::spawn_blocking(move || {
      init_ffmpeg();
      let ctx = ffmpeg_next::format::input(&path)
        .map_err(|e| Error::new(Status::GenericFailure, e.to_string()))?;
      probe::probe(&ctx)
    })
    .await
    .map_err(|e| Error::new(Status::GenericFailure, e.to_string()))?
  }

  /// Probe a media file from raw bytes.
  /// Uses custom AVIO — no temp file written to disk.
  #[napi]
  pub async fn probe_buffer(data: Buffer) -> Result<serde_json::Value> {
    let bytes: Vec<u8> = data.to_vec();

    tokio::task::spawn_blocking(move || {
      init_ffmpeg();
      let cursor = Cursor::new(bytes);
      let custom_io = ffmpeg_next::format::context::StreamIo::from_read_seek(cursor)
        .map_err(|e| Error::new(Status::GenericFailure, e.to_string()))?;
      let ctx = ffmpeg_next::format::input_from_stream(custom_io, None, None)
        .map_err(|e| Error::new(Status::GenericFailure, e.to_string()))?;
      probe::probe(&ctx)
    })
    .await
    .map_err(|e| Error::new(Status::GenericFailure, e.to_string()))?
  }

  /// Spawn the FFmpeg blocking probe and the write-loop task.
  /// Returns a Promise for the probe result.
  /// Must be called exactly once, before any `push()` / `finish()` calls.
  #[napi]
  pub fn start<'env>(&mut self, env: &'env Env) -> Result<PromiseRaw<'env, serde_json::Value>> {
    // Bounded channel: 4 slots gives ~256 KiB of buffering at 64 KiB
    // chunks.  When full, push() awaits — this is the backpressure
    // mechanism that slows down the JS for-await loop.
    let (tx, mut rx) = tokio::sync::mpsc::channel::<Vec<u8>>(4);
    self.tx = Some(tx);

    env.spawn_future(async move {
      let state = Arc::new((
        Mutex::new(WriteState {
          written: 0,
          done: false,
          mem_buf: Vec::new(),
          file_reader: None,
        }),
        Condvar::new(),
      ));
      let state_for_ffmpeg = state.clone();

      let mut probe_handle = tokio::task::spawn_blocking(move || {
        init_ffmpeg();
        let streaming = StreamingFile::new(state_for_ffmpeg);
        let custom_io = ffmpeg_next::format::context::StreamIo::from_read_seek(streaming)
          .map_err(|e| Error::new(Status::GenericFailure, e.to_string()))?;
        let ctx = ffmpeg_next::format::input_from_stream(custom_io, None, None)
          .map_err(|e| Error::new(Status::GenericFailure, e.to_string()))?;
        probe::probe(&ctx)
      });

      let mut temp_writer: Option<tempfile::NamedTempFile> = None;
      let mut write_err: Option<Error> = None;
      let mut probe_result: Option<Result<serde_json::Value>> = None;

      loop {
        tokio::select! {
            biased;

            // If FFmpeg finishes (success or failure), stop the write loop.
            result = &mut probe_handle, if probe_result.is_none() => {
                probe_result = Some(
                    result.map_err(|e| Error::new(Status::GenericFailure, e.to_string()))?
                );
                // Close the channel so push() returns false.
                rx.close();
                // Drain any already-buffered chunks so senders unblock.
                while rx.recv().await.is_some() {}
                break;
            }

            chunk = rx.recv() => {
                let bytes = match chunk {
                    Some(b) => b,
                    None => break, // channel closed (finish() called)
                };
                let len = bytes.len() as u64;

                if let Some(ref mut f) = temp_writer {
                    if let Err(e) = f.write_all(&bytes) {
                        write_err = Some(Error::new(Status::GenericFailure, e.to_string()));
                        break;
                    }
                    let (lock, cvar) = &*state;
                    let mut s = lock.lock().unwrap();
                    s.written += len;
                    cvar.notify_all();
                } else {
                    let written = {
                        let (lock, cvar) = &*state;
                        let mut s = lock.lock().unwrap();
                        s.mem_buf.extend_from_slice(&bytes);
                        s.written += len;
                        cvar.notify_all();
                        s.written
                    };

                    if written >= IN_MEM_THRESHOLD {
                        match spill_to_disk(&state) {
                            Ok(nf) => temp_writer = Some(nf),
                            Err(e) => {
                                write_err = Some(e);
                                break;
                            }
                        }
                    }
                }
            }
        }
      }

      // Signal EOF so the FFmpeg thread can unblock.
      {
        let (lock, cvar) = &*state;
        let mut s = lock.lock().unwrap();
        s.done = true;
        cvar.notify_all();
      }

      // If probe already completed in the select!, use that result.
      // Otherwise await it now.
      let probe_result = match probe_result {
        Some(r) => r,
        None => probe_handle
          .await
          .map_err(|e| Error::new(Status::GenericFailure, e.to_string()))?,
      };

      drop(temp_writer);

      match (write_err, probe_result) {
        (_, Ok(val)) => Ok(val),
        (Some(we), Err(_)) => Err(we),
        (None, Err(pe)) => Err(pe),
      }
    })
  }

  /// Push a chunk of bytes.  Returns a Promise that resolves to `true`
  /// if the chunk was accepted (keep pushing), or `false` if FFmpeg has
  /// already finished and no more data is needed.
  #[napi]
  pub async fn push(&self, chunk: Buffer) -> Result<bool> {
    let tx = self
      .tx
      .as_ref()
      .ok_or_else(|| Error::new(Status::GenericFailure, "push() called before start()"))?;

    match tx.send(chunk.to_vec()).await {
      Ok(()) => Ok(true),
      // Channel closed — FFmpeg finished or write loop broke.
      Err(_) => Ok(false),
    }
  }

  /// Signal that the stream has ended (EOF).
  #[napi]
  pub fn finish(&mut self) {
    // Dropping the sender closes the channel, which causes the write
    // loop's `rx.recv()` to return None → signals EOF.
    self.tx.take();
  }
}

/// Spill the in-memory buffer to a new NamedTempFile and hand an independent
/// read fd to StreamingFile via the shared state.
fn spill_to_disk(
  state: &Arc<(Mutex<WriteState>, Condvar)>,
) -> napi::Result<tempfile::NamedTempFile> {
  let mut named_temp = match std::env::var_os("FFPROBE_TMPDIR") {
    Some(dir) => tempfile::Builder::new().tempfile_in(dir),
    None => tempfile::NamedTempFile::new(),
  }
  .map_err(|e| Error::new(Status::GenericFailure, e.to_string()))?;

  let file_reader = named_temp
    .reopen()
    .map_err(|e| Error::new(Status::GenericFailure, e.to_string()))?;

  let (lock, cvar) = &**state;
  let snapshot = lock.lock().unwrap().mem_buf.clone();

  named_temp
    .write_all(&snapshot)
    .map_err(|e| Error::new(Status::GenericFailure, e.to_string()))?;

  {
    let mut s = lock.lock().unwrap();
    s.file_reader = Some(file_reader);
    s.mem_buf = Vec::new();
    cvar.notify_all();
  }

  Ok(named_temp)
}
