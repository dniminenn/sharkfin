// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later

// The same build id as src-tauri/build.rs. This crate compiles registry.rs by
// path rather than linking the desktop crate, so `SHARKFIN_COMMIT` has to be
// set here too or the browser build reports a bare version. Keep the two in
// step; the browser app is deployed from master, so its commit is the only
// thing that identifies a bundle.
fn main() {
    if let Some(commit) = git_commit() {
        println!("cargo:rustc-env=SHARKFIN_COMMIT={commit}");
    }
    for path in ["../../.git/HEAD", "../../.git/index"] {
        if std::path::Path::new(path).exists() {
            println!("cargo:rerun-if-changed={path}");
        }
    }
}

/// `None` when git is unavailable or this is not a checkout. A modified tree
/// is marked, so a bundle from a local build is never mistaken for the
/// released commit.
fn git_commit() -> Option<String> {
    // Only this repo's own .git counts. A tarball unpacked inside an unrelated
    // checkout would otherwise report that repo's commit, which is worse in a
    // bug report than reporting none.
    if !std::path::Path::new("../../.git").exists() {
        return None;
    }
    let run = |args: &[&str]| {
        std::process::Command::new("git")
            .args(args)
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
    };
    let short = run(&["rev-parse", "--short", "HEAD"]).filter(|s| !s.is_empty())?;
    let dirty = run(&["status", "--porcelain"]).is_some_and(|s| !s.is_empty());
    Some(if dirty {
        format!("{short}-dirty")
    } else {
        short
    })
}
