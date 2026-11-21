//! Every zip reader over any bytes: the strict index and its entries' data (world imports) and
//! the jar readers (plugin manifests). None may panic, loop or allocate without bound.
#![no_main]

use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    spawnloft_lib::zip::fuzz_read(data, 1 << 22);
});
