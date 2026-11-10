// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// What a drain pass amounted to, in the terms a person asking "did my data
/// get through?" can act on.
///
/// A drain reports counts, which answer a different question: `skipped: 1`
/// and `failed: 1` are both "one batch didn't make it" but call for opposite
/// responses — wait for the link to come back, versus stop waiting, because
/// the gateway is refusing this payload and will refuse it again.
public enum DrainOutcome: Hashable, Sendable {
    /// Batches went through and none failed.
    case delivered
    /// The gateway answered, and refused. Retrying reproduces it.
    case refused
    /// The phone retained the batches because the gateway says their source is paused.
    case paused
    /// The gateway refused this phone's write scope for at least one source.
    case blocked
    /// The gateway could not be reached. Retrying later is the fix.
    case unreachable
    /// Batches remain without a specific failure explaining why they are still queued.
    case stalled
    /// Batches are with the system's background upload queue, which
    /// finishes them even if the app is suspended.
    case sending
    /// Another drain already owns the buffer; this pass observed nothing.
    case busy
    /// Nothing was pending.
    case idle
    /// The drain itself failed — most commonly a dead token (401).
    case failed

    /// Classify a finished pass. `nil` stats mean the drain threw.
    ///
    /// Precedence is by what the user can act on: a transport failure
    /// outranks a refusal, because "Omnesis is unreachable" is both the more
    /// likely cause when both appear and the one with an obvious remedy.
    public init(_ stats: Uploader.Stats?) {
        guard let stats else {
            self = .failed
            return
        }
        // `blocked == nil` is the drain's marker for "this pass never walked
        // the buffer" — reporting its zeroed counts as success would claim a
        // delivery that never happened.
        // Batches with the background queue are still counted as remaining,
        // but nothing is wrong with them.
        let sending = stats.handedOff + stats.inBackground
        let queued = max(0, stats.remaining - sending)
        if stats.blocked == nil {
            self = .busy
        } else if stats.failed > 0 {
            self = .unreachable
        } else if stats.blocked?.isEmpty == false {
            self = .blocked
        } else if stats.skipped > 0 {
            self = .refused
        } else if queued > 0,
                  stats.rejected.contains(where: { $0.reason == "paused" }) {
            self = .paused
        } else if queued > 0,
                  !stats.rejected.isEmpty {
            self = .stalled
        } else if sending > 0 {
            self = .sending
        } else if stats.uploaded > 0 {
            self = .delivered
        } else if stats.remaining > 0 {
            self = .stalled
        } else {
            self = .idle
        }
    }
}
