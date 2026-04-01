#!/usr/bin/env bash
set -euo pipefail

FFMPEG_VERSION="${FFMPEG_VERSION:-8.1}"
JOBS="${JOBS:-$(nproc 2>/dev/null || sysctl -n hw.logicalcpu 2>/dev/null || echo 4)}"
EXTRA_CFLAGS="${EXTRA_CFLAGS:-}"
EXTRA_LDFLAGS="${EXTRA_LDFLAGS:-}"
FFMPEG_ARCH="${FFMPEG_ARCH:-$(uname -m)}"
FFMPEG_TARGET_OS="${FFMPEG_TARGET_OS:-}"
CC="${CC:-$(uname | grep -q Linux && (command -v musl-gcc >/dev/null 2>&1 && echo musl-gcc || echo gcc) || echo "")}"
AR="${AR:-}"

WORKDIR="${WORKDIR:-/tmp/ffmpeg-build}"

if [[ -d "$WORKDIR" ]]; then
  echo "Error: '$WORKDIR' already exists. Remove it to rebuild." >&2
  exit 1
fi

mkdir -p "$WORKDIR"
WORKDIR_ABS="$(cd "$WORKDIR" && pwd)"
OUTPUT_DIR="${OUTPUT_DIR:-${WORKDIR_ABS}/output}"

echo "Building FFmpeg ${FFMPEG_VERSION} → ${OUTPUT_DIR} (jobs: ${JOBS})"

# Dependencies (macOS)
if [[ "$(uname)" == "Darwin" ]]; then brew install nasm pkg-config 2>/dev/null || true; fi

# Download source
ARCHIVE="${WORKDIR_ABS}/ffmpeg-${FFMPEG_VERSION}.tar.bz2"
curl -fsSL "https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.bz2" -o "${ARCHIVE}"

cd "${WORKDIR_ABS}"
tar xf "ffmpeg-${FFMPEG_VERSION}.tar.bz2"
mv "ffmpeg-${FFMPEG_VERSION}" "source"
cd "source"

# Curated decoder list covering most common formats (~5-7MB).
# To enable all decoders (brings binary to ~13MB), replace the list with:
# --enable-decoders

./configure \
  --prefix="${OUTPUT_DIR}" \
  --disable-everything \
  --disable-doc \
  --disable-shared \
  --disable-programs \
  --disable-avdevice \
  --disable-swscale \
  --disable-network \
  --disable-bzlib \
  --disable-audiotoolbox \
  --disable-videotoolbox \
  --disable-avfoundation \
  --enable-pic \
  --enable-static \
  --enable-swresample \
  --enable-avformat \
  --enable-avcodec \
  --enable-avutil \
  --enable-demuxers \
  --enable-parsers \
  --enable-protocol=file \
  --enable-protocol=pipe \
  --enable-protocol=fd \
  --enable-bsfs \
  --enable-decoder=aac \
  --enable-decoder=ac3 \
  --enable-decoder=alac \
  --enable-decoder=amrnb \
  --enable-decoder=amrwb \
  --enable-decoder=av1 \
  --enable-decoder=cinepak \
  --enable-decoder=dnxhd \
  --enable-decoder=dvvideo \
  --enable-decoder=eac3 \
  --enable-decoder=flac \
  --enable-decoder=h263 \
  --enable-decoder=h264 \
  --enable-decoder=hevc \
  --enable-decoder=mjpeg \
  --enable-decoder=mp2 \
  --enable-decoder=mp3 \
  --enable-decoder=mp3float \
  --enable-decoder=mpeg1video \
  --enable-decoder=mpeg2video \
  --enable-decoder=mpeg4 \
  --enable-decoder=opus \
  --enable-decoder=pcm_alaw \
  --enable-decoder=pcm_f32be \
  --enable-decoder=pcm_f32le \
  --enable-decoder=pcm_mulaw \
  --enable-decoder=pcm_s16be \
  --enable-decoder=pcm_s16le \
  --enable-decoder=pcm_s24be \
  --enable-decoder=pcm_s24le \
  --enable-decoder=pcm_s32be \
  --enable-decoder=pcm_s32le \
  --enable-decoder=prores \
  --enable-decoder=theora \
  --enable-decoder=truehd \
  --enable-decoder=vorbis \
  --enable-decoder=vp8 \
  --enable-decoder=vp9 \
  --enable-decoder=wmav1 \
  --enable-decoder=wmav2 \
  --enable-decoder=wmv1 \
  --enable-decoder=wmv2 \
  --enable-decoder=wmv3 \
  --arch=${FFMPEG_ARCH} \
  ${FFMPEG_TARGET_OS:+--target-os=${FFMPEG_TARGET_OS}} \
  ${CC:+--cc=${CC}} \
  ${AR:+--ar=${AR}} \
  ${EXTRA_CFLAGS:+--extra-cflags="${EXTRA_CFLAGS}"} \
  ${EXTRA_LDFLAGS:+--extra-ldflags="${EXTRA_LDFLAGS}"}

make -j"${JOBS}"
make install

echo "FFmpeg static libs installed to ${OUTPUT_DIR}"
ls "${OUTPUT_DIR}/lib/"*.a
