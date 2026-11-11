// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

extension Uploader {
    struct BatchEffect {
        var uploaded = 0
        var handedOff = 0
        var heldBack = 0
        var failed = 0
        var skipped = 0
        var resetsConsecutiveFailures = false
        var isPermanentFailure = false
        var rejection: PushRejection?
        var blockedSourceId: String?
        /// A source that now has a batch in the background queue.
        var waitingSourceId: String?
        /// A source whose batch stays queued after failing this pass.
        var fencedSourceId: String?
    }

    /// What one batch amounted to. Each result projects a small, declarative
    /// effect that the drain loop folds into its pass-wide state.
    enum BatchResult {
        case uploaded
        /// Given to the background upload queue; its result arrives later.
        case handedOff(sourceId: String)
        /// An earlier batch of the same source is still in the background
        /// queue, so this one waits for it.
        case heldBehindBackground(sourceId: String)
        /// Delivered, but the queued file could not be deleted afterwards.
        case deliveredButRetained
        /// The gateway declined the source itself (removed / paused).
        case sourceRejected(sourceId: String, reason: String)
        /// 403 — this device's token lacks the source's write scope. The
        /// source id is absent when the batch file could not be read.
        case sourceBlocked(sourceId: String?)
        /// Repeating cannot change the result; counts against the batch's
        /// quarantine budget. The source id is absent when the batch file
        /// could not be read.
        case permanentlyRefused(sourceId: String?)
        /// The world may fix this on its own; never costs the batch data.
        case transientFailure(sourceId: String?)
        /// An earlier batch of the same source failed this pass and is still
        /// queued, so this one was not attempted.
        case heldBehindFailure
        /// Replicated deletion was deliberately refused to this non-holder.
        case replicaDeletionDeferred
        /// The file went away between listing and loading it.
        case vanished
        /// An earlier batch of the same source was refused with 403 this
        /// pass, so this one was not attempted.
        case skippedBlockedSource

        var effect: BatchEffect {
            switch self {
            case .uploaded:
                BatchEffect(uploaded: 1, resetsConsecutiveFailures: true)
            case .handedOff(let sourceId):
                BatchEffect(handedOff: 1, resetsConsecutiveFailures: true, waitingSourceId: sourceId)
            case .heldBehindBackground(let sourceId):
                BatchEffect(heldBack: 1, waitingSourceId: sourceId)
            case .deliveredButRetained:
                BatchEffect(uploaded: 1, resetsConsecutiveFailures: true, isPermanentFailure: true)
            case .sourceRejected(let sourceId, let reason):
                BatchEffect(
                    resetsConsecutiveFailures: true,
                    rejection: PushRejection(sourceId: sourceId, reason: reason)
                )
            case .sourceBlocked(let sourceId):
                BatchEffect(skipped: 1, resetsConsecutiveFailures: true, blockedSourceId: sourceId)
            case .permanentlyRefused(let sourceId):
                BatchEffect(
                    skipped: 1, resetsConsecutiveFailures: true, isPermanentFailure: true, fencedSourceId: sourceId
                )
            case .transientFailure(let sourceId):
                BatchEffect(failed: 1, fencedSourceId: sourceId)
            case .heldBehindFailure:
                // Waiting, not failing: the failure is the earlier batch's.
                BatchEffect()
            case .replicaDeletionDeferred:
                // Another healthy replica owns deletion authority. Retaining
                // the batch is expected coordination, not a failure.
                BatchEffect(resetsConsecutiveFailures: true)
            case .vanished:
                BatchEffect()
            case .skippedBlockedSource:
                BatchEffect(skipped: 1)
            }
        }
    }

    /// Sources whose remaining batches this pass leaves queued.
    struct SourceHolds {
        /// Refused with 403 this pass.
        private(set) var blocked: Set<String> = []
        /// With a batch that stays queued after a failed attempt this pass.
        /// Their later batches wait for the next pass, so none lands ahead
        /// of it.
        private(set) var fenced: Set<String> = []

        mutating func note(_ effect: BatchEffect) {
            if let sourceId = effect.blockedSourceId { blocked.insert(sourceId) }
            if let sourceId = effect.fencedSourceId { fenced.insert(sourceId) }
        }
    }
}
