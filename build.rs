extern crate napi_build;

fn main() {
  napi_build::setup();

  // FFmpeg on Windows requires these system libraries
  if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
    println!("cargo:rustc-link-lib=bcrypt");
    println!("cargo:rustc-link-lib=user32");
  }
}
