#!/bin/sh
# Rustc wrapper for Alpine/musl builds.
#
# Build scripts (proc-macros, build.rs) are compiled without --target because
# they run on the host. Without -C target-feature=-crt-static, those build
# scripts are fully static musl binaries that cannot use dlopen — which bindgen
# requires to load libclang.so at build time.
#
# The target .node cdylib IS compiled with --target and must NOT get
# -crt-static disabled: keeping the default +crt-static embeds musl libc into
# the cdylib so it is self-contained and loads on both Alpine (musl) and
# Debian/Ubuntu (glibc) Linux systems without a musl shared library dependency.
#
# This wrapper therefore adds -C target-feature=-crt-static only when --target
# is absent (i.e., host/build-script compilations). It is a no-op on macOS and
# glibc Linux.
rustc_bin="$1"
shift

case "$(ldd /usr/bin/env 2>&1)" in
  *musl*)
    has_target=0
    for arg in "$@"; do
      [ "$arg" = "--target" ] && has_target=1 && break
    done
    if [ "$has_target" = "0" ]; then
      exec "$rustc_bin" "$@" -C target-feature=-crt-static
    else
      exec "$rustc_bin" "$@"
    fi
    ;;
  *)
    exec "$rustc_bin" "$@"
    ;;
esac
