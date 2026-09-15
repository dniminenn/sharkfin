// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later

// Same build id as src-tauri/build.rs. This crate compiles registry.rs by
// path, so SHARKFIN_COMMIT has to be set here too. Browser deploys from
// master; the commit is what identifies a bundle.
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

/// `None` when git is unavailable or this is not a checkout. A dirty tree
/// is marked so a local build is not mistaken for the released commit.
fn git_commit() -> Option<String> {
    // Only this repo's .git. A tarball inside some other checkout would
    // otherwise report that repo's commit.
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
