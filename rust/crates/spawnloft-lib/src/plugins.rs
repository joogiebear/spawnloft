//! The part of `plugins.mjs` the lifecycle needs before C5 ports the rest.

use crate::js;
use crate::registry::Instance;

/// `mcVersionOf(inst)`: the recorded `mcVersion` (as `String()` prints it), else the version the
/// jar's name carries.
pub fn mc_version_of(inst: &Instance) -> Option<String> {
    let recorded = inst.get("mcVersion");
    if js::truthy(recorded) {
        return Some(js::string(recorded));
    }
    match inst.get("jar") {
        v if js::truthy(v) => crate::software::version_from_jar(&js::string(v)),
        _ => None,
    }
}
