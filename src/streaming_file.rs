use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::sync::{Arc, Condvar, Mutex};

pub struct WriteState {
    pub written: u64,
    pub done: bool,
    /// Bytes buffered in memory before a disk spill occurs.
    pub mem_buf: Vec<u8>,
    /// Independent read fd handed to StreamingFile once a spill has occurred.
    /// Taken (moved out) by the first StreamingFile that needs file-mode reads.
    pub file_reader: Option<File>,
}

/// A `Read + Seek` adapter that first serves bytes from an in-memory buffer
/// and transparently switches to an on-disk file once the writer spills.
///
/// The writer signals progress via the condvar after every chunk; this type
/// blocks on that condvar whenever it reads past the write frontier.
pub struct StreamingFile {
    state: Arc<(Mutex<WriteState>, Condvar)>,
    pos: u64,
    /// Owned read fd, moved out of `WriteState::file_reader` on first file-mode
    /// access.  `None` while still in memory mode.
    file: Option<File>,
}

impl StreamingFile {
    pub fn new(state: Arc<(Mutex<WriteState>, Condvar)>) -> Self {
        Self { state, pos: 0, file: None }
    }
}

impl Read for StreamingFile {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let (lock, cvar) = &*self.state;

        loop {
            let mut state = lock.lock().unwrap();

            // Lazily acquire the file handle once the writer has spilled.
            if self.file.is_none() {
                if let Some(f) = state.file_reader.take() {
                    self.file = Some(f);
                }
            }

            if self.file.is_some() {
                // FILE MODE — wait until the writer has data at our position.
                while self.pos >= state.written && !state.done {
                    state = cvar.wait(state).unwrap();
                }
                if self.pos >= state.written {
                    return Ok(0); // EOF
                }
                drop(state); // release lock before I/O
                let file = self.file.as_mut().unwrap();
                file.seek(SeekFrom::Start(self.pos))?;
                let n = file.read(buf)?;
                self.pos += n as u64;
                return Ok(n);
            }

            // MEMORY MODE — serve from the in-memory buffer, or wait for new
            // data, a spill notification, or EOF.
            let mem_len = state.mem_buf.len();
            if self.pos as usize >= mem_len {
                if state.done {
                    return Ok(0); // EOF
                }
                // Wait for more data, a spill, or done.  The MutexGuard is
                // consumed by cvar.wait and re-acquired on return; it is then
                // dropped at the end of this loop iteration (before the next
                // lock().unwrap() at the top), so there is no deadlock.
                drop(cvar.wait(state).unwrap());
                continue;
            }

            let start = self.pos as usize;
            let end = (start + buf.len()).min(mem_len);
            let n = end - start;
            buf[..n].copy_from_slice(&state.mem_buf[start..end]);
            self.pos += n as u64;
            return Ok(n);
        }
    }
}

impl Seek for StreamingFile {
    fn seek(&mut self, from: SeekFrom) -> io::Result<u64> {
        let (lock, cvar) = &*self.state;

        let new_pos: u64 = match from {
            SeekFrom::Start(n) => {
                // Wait until n bytes have been written (or the stream is done).
                let mut state = lock.lock().unwrap();
                loop {
                    if state.written >= n || state.done {
                        break;
                    }
                    state = cvar.wait(state).unwrap();
                }
                n
            }
            SeekFrom::Current(n) => {
                let target = self.pos as i64 + n;
                if target < 0 {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        "seek to negative position",
                    ));
                }
                let target = target as u64;
                let mut state = lock.lock().unwrap();
                loop {
                    if state.written >= target || state.done {
                        break;
                    }
                    state = cvar.wait(state).unwrap();
                }
                target
            }
            SeekFrom::End(n) => {
                // Must wait for the stream to finish to know the total size.
                let mut state = lock.lock().unwrap();
                loop {
                    if state.done {
                        break;
                    }
                    state = cvar.wait(state).unwrap();
                }
                let end = state.written as i64;
                let target = end + n;
                if target < 0 {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        "seek to negative position",
                    ));
                }
                target as u64
            }
        };

        self.pos = new_pos;
        // Physical seek is deferred to the next read() call, where
        // file.seek(SeekFrom::Start(self.pos)) is issued before reading.
        // In memory mode no physical seek is needed (pos is an index into mem_buf).
        Ok(new_pos)
    }
}
