//! `inflateRawSync` over any bytes (a jar entry's data), and the names of the strict reader.
#![no_main]

use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    if data.len() <= 4096 {
        let _ = spawnloft_lib::zip::jar::inflate_raw(data);
    }
    let _ = spawnloft_lib::zip::decode_name(data, 0);
    let _ = spawnloft_lib::zip::decode_name(data, 0x0800);
});
