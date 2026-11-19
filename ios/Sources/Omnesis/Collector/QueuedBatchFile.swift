// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// The name of a queued batch's file in `OfflineBuffer`:
/// `<sequence>_<id>.json`, the sequence zero-padded so names sort in
/// queue order. Files from before sequences are named `<id>.json`.
enum QueuedBatchFile {
    static func name(sequence: UInt64, id: String) -> String {
        "\(String(format: "%020llu", sequence))_\(id).json"
    }

    /// The sequence and batch id a file name carries; a file from before
    /// sequences has no sequence.
    static func parse(_ name: String) -> (sequence: UInt64?, id: String) {
        let stem = (name as NSString).deletingPathExtension
        guard let separator = stem.firstIndex(of: "_"),
              stem.distance(from: stem.startIndex, to: separator) == 20,
              let sequence = UInt64(stem[..<separator]) else { return (nil, stem) }
        return (sequence, String(stem[stem.index(after: separator)...]))
    }

    static func batchId(of url: URL) -> String {
        parse(url.lastPathComponent).id
    }
}
