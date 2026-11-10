// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Drains the offline buffer into the gateway, one batch at a time,
/// oldest first. Errors are handled per-batch so one bad batch doesn't
/// stall the queue behind it:
///   - 401 → rethrow immediately. The token is no longer valid at all,
///     so nothing in the queue can be delivered; the UI prompts a re-pair.
///   - 403 → this source's writes are unauthorized (the token lacks
///     `write:<source-type>`). Scoped to that source, not to the link, so
///     the batch is skipped and recorded in `Stats.blocked` and the drain
///     continues. Skipping matters: the buffer is strict FIFO, so
///     rethrowing here would strand every healthy source's batches behind
///     one unauthorized source indefinitely, while cursors kept advancing.
///   - 4xx (400 / 404 / 422 …) → persistent, not retryable on this
///     end. Skip past this batch; it stays on disk. The next drain cycle
///     will try it again if the server-side situation has changed.
///   - Network / 5xx / batch-file read failures → transient. After
///     `maxConsecutiveFailures` in a row we conclude the link is down
///     (or the buffer is sealed by file protection during a
///     locked-device wake) and stop early — next drain cycle picks up
///     where we left off.
///
/// "Skip and retry next cycle" has no end on its own, so every outcome is
/// additionally classified as transient or permanent, and permanent ones
/// are recorded against the batch (`OfflineBuffer.recordPermanentFailure`).
/// A batch that collects enough of them is quarantined out of the queue.
/// Without that, one batch the gateway will never accept is retried and
/// skipped for the life of the install while its age — the signal behind
/// the delivery-health warning — climbs forever.
///
/// Permanent means "repeating this cannot change the outcome", which is
/// narrower than "it failed":
///
///   - A 4xx the gateway means as a verdict on the payload. Not every 4xx
///     is: 401 and 403 are about the token, and the retryable statuses
///     are explicit "ask again later" answers that a proxy in front of the
///     gateway can emit under nothing worse than load or a slow uplink.
///     `DeliveryClassification` holds the rule, so every delivery path
///     reads a failure the same way.
///   - A `DecodingError` from the batch file is bytes on disk that do not
///     parse. Distinct from a *read* failure, which is routine while the
///     device is locked and stays transient.
///   - A delivered batch that cannot be deleted afterwards would be
///     re-sent on every drain forever.
///
/// Everything else stays transient however long it persists — no network,
/// 5xx, a sealed buffer, a 403 waiting on a scope grant, a paused source,
/// and a reply this app cannot decode (which a captive portal or a proxy
/// error page produces just as readily as a genuine protocol mismatch).
/// Those are states the world resolves on its own, and dropping data
/// because a gateway was unreachable for a week would be a far worse bug
/// than the one quarantine fixes.
public actor Uploader {
    private final class GatewayRoute: @unchecked Sendable {
        private let lock = NSLock()
        private var gateway: GatewayClient

        init(gateway: GatewayClient) {
            self.gateway = gateway
        }

        func current() -> GatewayClient {
            lock.lock()
            defer { lock.unlock() }
            return gateway
        }

        func update(_ gateway: GatewayClient) {
            lock.lock()
            defer { lock.unlock() }
            self.gateway = gateway
        }
    }

    private nonisolated let gatewayRoute: GatewayRoute
    private let buffer: OfflineBuffer
    private let budget: (any ExecutionBudget)?
    private let log = AppLog.make(category: "collector.uploader")
    private var draining = false
    private let background: BackgroundUploads?
    /// Background results the next drain reports, as if it had seen them:
    /// a 401 (thrown), source rejections, and 403s by source. A 403'd
    /// source's batches go through the foreground drain until one is
    /// delivered, so the refusal reaches `Stats.blocked` the usual way.
    private var backgroundUnauthorized = false
    private var backgroundRejections: [String: String] = [:]
    private var backgroundBlocked: Set<String> = []

    /// After this many transient failures back-to-back with no successful
    /// upload in between, give up the drain pass. Keeps us from burning
    /// battery hammering an offline gateway.
    private let maxConsecutiveFailures = 3

    public struct Stats: Equatable, Sendable {
        public var uploaded: Int
        public var failed: Int
        public var skipped: Int
        public var remaining: Int
        /// Sources the gateway rejected this pass (removed/paused in Omnesis),
        /// deduped and sorted. The caller (CollectorCore → AppStore) reacts:
        /// a `removed` source is disabled locally; a `paused` one is surfaced.
        public var rejected: [PushRejection] = []
        /// Sources whose batches the gateway refused with 403 this pass,
        /// deduped and sorted — or `nil` when this pass never got as far as
        /// walking the buffer, so it observed nothing either way.
        ///
        /// The distinction matters: a caller that treats "no observation" as
        /// "nothing blocked" clears the warning the moment a concurrent drain
        /// short-circuits, making the banner flicker off while the source is
        /// still refused. The device's token is missing `write:<source-type>`;
        /// the data stays buffered and delivers once the scope is granted.
        public var blocked: [String]?
        /// True when the pass stopped short of the buffer's end because too
        /// little background time was left to start another upload. What it
        /// left stays queued for the next drain.
        public var stoppedForTime = false
        /// Batches this pass handed to the background upload queue.
        public var handedOff = 0
        /// Batches an earlier pass handed off whose result isn't in yet,
        /// and later batches of their sources held back behind them; this
        /// pass left them alone.
        public var inBackground = 0
    }

    public init(
        gateway: GatewayClient,
        buffer: OfflineBuffer,
        budget: (any ExecutionBudget)? = nil,
        background: BackgroundUploads? = nil
    ) {
        gatewayRoute = GatewayRoute(gateway: gateway)
        self.buffer = buffer
        self.budget = budget
        self.background = background
    }

    /// Route future drain passes to updated pairing credentials without
    /// replacing this actor's one-drain lock. A pass already in flight keeps
    /// one gateway snapshot for all of its requests.
    public nonisolated func updateGateway(_ gateway: GatewayClient) {
        gatewayRoute.update(gateway)
    }

    /// Drain the buffer. Returns counts of batches uploaded / failed /
    /// skipped this pass, plus the sources rejected (removed/paused) and
    /// blocked (403) along the way. Rethrows only on 401 — the token itself
    /// is dead, so the UI must prompt for a re-pair.
    @discardableResult
    public func drain() async throws -> Stats {
        if draining {
            log.debug("Drain already in progress, skipping")
            // Another drain owns the buffer — this pass observed nothing.
            return try await Stats(uploaded: 0, failed: 0, skipped: 0, remaining: buffer.count(), blocked: nil)
        }
        draining = true
        defer { draining = false }
        let ids = try await buffer.listIds()
        let pass = try await startBackgroundPass(ids: ids)

        var uploaded = 0
        var failed = 0
        var skipped = 0
        var quarantined = 0
        var consecutiveFailures = 0
        // sourceId → reason for any source the gateway rejected this pass.
        var rejections = pass.rejections
        // Sources the gateway refused with 403 this pass.
        var blocked: Set<String> = []
        // Sources with a batch that stays queued after a failed attempt this
        // pass. Their later batches wait for the next pass, so none lands
        // ahead of it.
        var fenced: Set<String> = []
        var stoppedForTime = false
        var handedOff = 0
        var inBackground = 0
        var order = BackgroundOrder(pass: pass)
        let gateway = gatewayRoute.current()

        drainPass: for (index, id) in ids.enumerated() {
            switch order.place(of: id, at: index) {
            case .send: break
            case .withSystem:
                inBackground += 1
                continue drainPass
            case .holdRest:
                inBackground += ids.count - index
                break drainPass
            }
            // An upload that iOS suspends halfway is sent again in full on the
            // next wake, so one that can't finish only spends the time left.
            guard await budget?.allows(ExecutionMargin.upload) ?? true else {
                stoppedForTime = true
                log.notice("Stopping drain: too little background time left for another upload")
                break drainPass
            }
            let effect = try await deliver(
                id: id,
                blockedSources: blocked,
                waitingSources: order.waiting,
                fencedSources: fenced,
                gateway: gateway,
                handOff: pass.handOff
            ).effect
            uploaded += effect.uploaded
            handedOff += effect.handedOff
            inBackground += order.note(effect)
            failed += effect.failed
            skipped += effect.skipped
            consecutiveFailures = effect.resetsConsecutiveFailures ? 0 : consecutiveFailures + effect.failed
            if let rejection = effect.rejection {
                rejections[rejection.sourceId] = rejection.reason
            }
            if let sourceId = effect.blockedSourceId {
                blocked.insert(sourceId)
            }
            if let sourceId = effect.fencedSourceId {
                fenced.insert(sourceId)
            }
            if effect.isPermanentFailure, await notePermanentFailure(id: id) {
                quarantined += 1
            }
            if consecutiveFailures >= maxConsecutiveFailures {
                log.notice(
                    "Stopping drain after \(consecutiveFailures, privacy: .public) consecutive transient failures"
                )
                break drainPass
            }
        }

        let remaining = try await buffer.count()
        if uploaded > 0 || failed > 0 || skipped > 0 || handedOff > 0 {
            let counts = "\(uploaded) uploaded, \(handedOff) handed off, \(skipped) skipped, \(failed) failed, "
                + "\(quarantined) quarantined, \(remaining) remaining"
            log.notice("Drain pass: \(counts, privacy: .public)")
        }
        return Stats(
            uploaded: uploaded,
            failed: failed,
            skipped: skipped,
            remaining: remaining,
            rejected: rejections
                .map { PushRejection(sourceId: $0.key, reason: $0.value) }
                .sorted { $0.sourceId < $1.sourceId },
            blocked: blocked.sorted(),
            stoppedForTime: stoppedForTime,
            handedOff: handedOff,
            inBackground: inBackground
        )
    }

    private struct BatchEffect {
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
    private enum BatchResult {
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

    /// Attempt one batch. Throws only on 401 — the token itself is dead, so
    /// there is no point continuing the pass.
    private func deliver(
        id: String,
        blockedSources: Set<String>,
        waitingSources: Set<String>,
        fencedSources: Set<String>,
        gateway: GatewayClient,
        handOff: Bool
    ) async throws
        -> BatchResult {
        // Set once the batch file is readable, so the 403 case can attribute
        // the rejection to a source without re-reading it.
        var batchSourceId: String?
        do {
            // Loaded inside the per-batch handling so a single unreadable
            // batch file — routine during a locked-device wake now that batch
            // files carry `.completeUnlessOpen`, or a corrupt file — counts as
            // one transient failure instead of aborting the whole drain pass.
            guard let batch = try await buffer.load(id: id) else { return .vanished }
            batchSourceId = batch.sourceId
            // One 403 settles the whole source for this pass. Re-probing every
            // remaining batch of it would cost a round-trip each, and `push`
            // sends analytics before documents — so a source whose analytics
            // rows are accepted but whose documents are refused would re-send
            // those rows on every batch.
            if blockedSources.contains(batch.sourceId) {
                return .skippedBlockedSource
            }
            if waitingSources.contains(batch.sourceId) {
                return .heldBehindBackground(sourceId: batch.sourceId)
            }
            // A batch sent past an earlier one of its source that failed would
            // land first: a deletion before the insert it follows, a newer row
            // before an older one.
            if fencedSources.contains(batch.sourceId) {
                return .heldBehindFailure
            }
            if handOff, !backgroundBlocked.contains(batch.sourceId),
               let endpoint = BackgroundUploadEndpoint(batch: batch),
               await handToBackground(batch, endpoint: endpoint, gateway: gateway) {
                return .handedOff(sourceId: batch.sourceId)
            }

            let pushOutcome = try await pushWithReplicaLease(batch, gateway: gateway)
            if pushOutcome.deletionDeferred {
                return .replicaDeletionDeferred
            }
            if let reason = pushOutcome.rejectedReason {
                if reason == "removed" {
                    // The source is gone — discard the batch; there's nothing
                    // to deliver it to. A delete that fails must not swallow
                    // the rejection: it is the signal that disables the source
                    // locally, and without it the phone keeps buffering for a
                    // source that no longer exists.
                    try? await buffer.remove(id: batch.id)
                }
                // "paused" → leave the batch on disk so the data is not lost
                // and delivers when the source is resumed in Omnesis.
                return .sourceRejected(sourceId: batch.sourceId, reason: reason)
            }

            backgroundBlocked.remove(batch.sourceId)
            do {
                try await buffer.remove(id: batch.id)
                return .uploaded
            } catch {
                // Delivered, but the file survived. Every later drain re-sends
                // it — harmless (the ingest is an idempotent upsert) and
                // endless, since deleting will fail again for whatever reason
                // it failed now.
                log.error(
                    "Batch \(id, privacy: .public) delivered but not removed: \(String(describing: error), privacy: .private)"
                )
                return .deliveredButRetained
            }
        } catch {
            return try classify(error, id: id, batchSourceId: batchSourceId)
        }
    }

    /// What a failed delivery means for the batch, by the rule every
    /// delivery path shares (`DeliveryClassification`). Throws only on 401.
    private func classify(_ error: any Error, id: String, batchSourceId: String?) throws -> BatchResult {
        let failure = DeliveryClassification.failure(from: error)
        switch DeliveryClassification.verdict(for: failure, batchAge: Batch.age(ofId: id)) {
        case .reauthorize:
            log.error("Gateway returned 401 during drain — needs re-pair")
            throw GatewayClient.Error.unauthorized
        case .blocked:
            // Unauthorized for THIS source only — the token is otherwise
            // valid. Leave the batch on disk (it delivers once the scope is
            // granted) and keep draining so other sources aren't stranded
            // behind it. Logged once per source per pass; the drain loop's
            // blocked set is the dedupe.
            if let sourceId = batchSourceId {
                log.notice(
                    "Gateway returned 403 for source \(sourceId, privacy: .private); batches retained until write scope is restored"
                )
            } else {
                log.warning("Gateway returned 403 for an unreadable batch \(id, privacy: .public)")
            }
            return .sourceBlocked(sourceId: batchSourceId)
        case .refuse:
            // Move on so the rest of the queue can still drain. The batch
            // stays on disk; a future drain retries it (e.g. after the
            // gateway schema catches up) until it runs out of budget.
            log.warning(
                "Batch \(id, privacy: .public) refused: \(String(describing: failure), privacy: .private)"
            )
            return .permanentlyRefused(sourceId: batchSourceId)
        case .retry:
            log.notice(
                "Batch \(id, privacy: .public) not delivered, retrying next drain: \(String(describing: failure), privacy: .private)"
            )
            return .transientFailure(sourceId: batchSourceId)
        }
    }

    /// Record a failure that repeating cannot fix. Returns true when the
    /// batch ran out of budget and was quarantined, so the caller can count
    /// it. A quarantine that itself fails is reported and otherwise ignored
    /// — the batch stays queued and the next pass tries again.
    private func notePermanentFailure(id: String) async -> Bool {
        do {
            let didQuarantine = try await buffer.recordPermanentFailure(id: id)
            if didQuarantine {
                log.notice(
                    "Batch \(id, privacy: .public) set aside as undeliverable after repeated permanent failures"
                )
            }
            return didQuarantine
        } catch {
            log.error(
                "Could not quarantine batch \(id, privacy: .public): \(String(describing: error), privacy: .private)"
            )
            return false
        }
    }

    private struct PushOutcome {
        var rejectedReason: String?
        var deletionDeferred = false
    }

    /// Claims deletion authority around every structured deletion batch.
    /// A 404 means an older gateway where the source is still exclusive.
    private func pushWithReplicaLease(_ batch: Batch, gateway: GatewayClient) async throws -> PushOutcome {
        // Claim for every analytics deletion, including legacy buffered batches
        // that predate the persisted mode field. A 404 is the compatibility
        // seam for an old exclusive gateway; a current replicated gateway must
        // never receive an unleased legacy deletion forever.
        let needsLease = batch.tableName != nil && !batch.deletedIds.isEmpty
        guard needsLease else { return try await push(batch, gateway: gateway) }

        let lease = try await gateway.claimSyncLease(sourceId: batch.sourceId)
        guard lease?.granted != false else {
            return PushOutcome(deletionDeferred: true)
        }
        do {
            let outcome = try await push(batch, gateway: gateway)
            if lease != nil { try? await gateway.releaseSyncLease(sourceId: batch.sourceId) }
            return outcome
        } catch {
            if lease != nil { try? await gateway.releaseSyncLease(sourceId: batch.sourceId) }
            throw error
        }
    }

    /// Pushes one batch's analytics rows, bound documents, and deletions
    /// (in that order), stopping at the first rejection. Returns the
    /// gateway's rejection reason for this source, if any.
    private func push(_ batch: Batch, gateway: GatewayClient) async throws -> PushOutcome {
        var rejectedReason: String?
        var deletionDeferred = false
        if let tableName = batch.tableName,
           !batch.records.isEmpty || batch.schema != nil || !batch.deletedIds.isEmpty {
            let resp = try await gateway.ingestAnalyticsRecords(
                tableName: tableName,
                records: batch.records,
                schema: batch.schema,
                sourceId: batch.sourceId,
                deletedIds: batch.deletedIds
            )
            rejectedReason = resp.rejected.first { $0.sourceId == batch.sourceId }?.reason
            deletionDeferred = resp.deletionDeferred
        }
        // Push the bound documents AFTER the analytics rows land so the
        // row a document binds to (via `boundDocument`) already exists
        // when the gateway synthesizes the same-entity edge.
        // Idempotent upsert, so a retry can't double-write.
        if rejectedReason == nil, !batch.documents.isEmpty {
            let resp = try await gateway.ingestDocuments(batch.documents)
            rejectedReason = resp.rejected.first { $0.sourceId == batch.sourceId }?.reason
        }
        // A documents-only source (`tableName == nil`, e.g. Photos)
        // has no analytics rows to delete-by-id, so its `deletedIds` mean
        // document external ids instead — route them to the
        // document-delete endpoint. A deletion-only batch (no documents
        // this cycle) has no other call site that would surface a
        // removed/paused rejection, so this response must be checked too
        // — otherwise a paused source's buffered deletions would apply
        // anyway.
        if rejectedReason == nil, batch.tableName == nil, !batch.deletedIds.isEmpty {
            let resp = try await gateway.deleteDocuments(
                providerId: batch.sourceId,
                sourceId: batch.sourceId,
                externalIds: batch.deletedIds
            )
            rejectedReason = resp.rejected.first { $0.sourceId == batch.sourceId }?.reason
        }
        return PushOutcome(rejectedReason: rejectedReason, deletionDeferred: deletionDeferred)
    }
}

// MARK: - Background uploads

extension Uploader {
    private struct BackgroundPass {
        /// Source rejections background results reported since the last pass.
        let rejections: [String: String]
        /// Batches the system holds a task for, with their source: from the
        /// record of hand-offs, and from the tasks themselves whatever the
        /// record says.
        let outstanding: [String: String]
        /// Where in the queue the batches stop being sendable: the first a
        /// task is out for whose source can't be read, or the start when a
        /// task is out for a batch no longer queued. It and every later
        /// batch wait.
        let holdFrom: Int?
        let handOff: Bool
    }

    /// Where a batch stands against the background queue this pass.
    private enum BackgroundPlace {
        case send
        /// Handed off by an earlier pass; its result isn't in yet.
        case withSystem
        /// The record can't say whose batches are out: this batch and every
        /// later one wait behind the earliest the system holds.
        case holdRest
    }

    /// Delivery in order per source. The system finishes background tasks
    /// in no particular order, so while a batch of a source is with it,
    /// that source's later batches wait: a deletion sent ahead of the
    /// insert before it would be undone when the insert lands, and so
    /// would a newer version of a row by an older one.
    private struct BackgroundOrder {
        let pass: BackgroundPass
        /// Sources with a batch in the background queue.
        private(set) var waiting: Set<String> = []

        init(pass: BackgroundPass) {
            self.pass = pass
        }

        mutating func place(of id: String, at index: Int) -> BackgroundPlace {
            if let holdFrom = pass.holdFrom, index >= holdFrom { return .holdRest }
            if let sourceId = pass.outstanding[id] {
                waiting.insert(sourceId)
                return .withSystem
            }
            return .send
        }

        /// Note a batch's effect; returns the batches it held back.
        mutating func note(_ effect: BatchEffect) -> Int {
            if let sourceId = effect.waitingSourceId { waiting.insert(sourceId) }
            return effect.heldBack
        }
    }

    /// What background uploads bring to a drain pass over `ids`: results
    /// recorded since the last one, the batches still with their task, and
    /// whether this pass hands batches off. Throws the 401 a background
    /// upload got.
    private func startBackgroundPass(ids: [String]) async throws -> BackgroundPass {
        if backgroundUnauthorized {
            backgroundUnauthorized = false
            log.error("Gateway returned 401 to a background upload — needs re-pair")
            throw GatewayClient.Error.unauthorized
        }
        let live = await reconcileBackgroundUploads()
        let rejections = backgroundRejections
        backgroundRejections = [:]
        // Hand-offs need the record of them; while it can't be read or
        // decoded, none are made.
        let marks = await background == nil ? [:] : (try? buffer.backgroundUploadMarks())
        var outstanding = (marks ?? [:]).mapValues(\.sourceId)
        var holdFrom: Int?
        // The tasks' own tags say which batches are out, whatever the record
        // says: a record lost or written over must not send a batch again,
        // or the rest of its source, while its task can still land.
        let position = Dictionary(ids.enumerated().map { ($1, $0) }, uniquingKeysWith: { first, _ in first })
        for tag in live.compactMap(BackgroundUploadTag.init) where outstanding[tag.batchId] == nil {
            guard let index = position[tag.batchId] else {
                holdFrom = 0
                continue
            }
            if let sourceId = try? await buffer.load(id: tag.batchId)?.sourceId {
                outstanding[tag.batchId] = sourceId
            } else {
                holdFrom = min(holdFrom ?? index, index)
            }
        }
        let handOff = await shouldHandOff() && marks != nil
        return BackgroundPass(rejections: rejections, outstanding: outstanding, holdFrom: holdFrom, handOff: handOff)
    }

    /// Hand batches off this pass only when the person turned it on and the
    /// phone is unlocked, so the outbox file is readable when the upload
    /// starts. Otherwise every batch takes the foreground path.
    private func shouldHandOff() async -> Bool {
        guard let background, background.isEnabled() else { return false }
        return await background.protectedDataAvailable()
    }

    /// Write the batch's one request body to the outbox, mark the batch, and
    /// start the task — in that order, so a result can never arrive for a
    /// batch not yet marked. False when any step fails; the batch then takes
    /// the foreground path in the same pass.
    private func handToBackground(
        _ batch: Batch,
        endpoint: BackgroundUploadEndpoint,
        gateway: GatewayClient
    ) async
        -> Bool {
        guard let background else { return false }
        let tag = BackgroundUploadTag(batchId: batch.id, endpoint: endpoint)
        do {
            let (request, body) = try gateway.backgroundUploadRequest(for: batch, to: endpoint)
            let file = try await buffer.prepareBackgroundUpload(body, tag: tag, sourceId: batch.sourceId)
            background.transport.upload(request, fromFile: file, tag: tag.description)
            return true
        } catch {
            log.notice(
                "Batch \(batch.id, privacy: .public) not handed off: \(String(describing: error), privacy: .private)"
            )
            try? await buffer.finishBackgroundUpload(tag: tag)
            return false
        }
    }

    /// Forget hand-offs whose task the system no longer holds — lost across
    /// a relaunch, or whose result arrived while the record couldn't be
    /// read — so their batches go back to the ordinary queue. Every drain:
    /// asking the system is cheap, and a mark nothing clears would hold its
    /// batch back for good. Returns the tags of the tasks the system holds.
    private func reconcileBackgroundUploads() async -> Set<String> {
        guard let background else { return [] }
        let live = await background.transport.pendingTags()
        do {
            let cleared = try await buffer.reconcileBackgroundUploads(liveTags: live)
            if cleared > 0 {
                log.notice("\(cleared, privacy: .public) background uploads lost their task; queued again")
            }
        } catch {
            // The record can't be read (a locked phone); the next drain retries.
        }
        return live
    }

    /// Record what a background upload came to, by the same rule the
    /// foreground drain uses. A result for a hand-off the batch's mark no
    /// longer names — from before a re-pair, or superseded — changes
    /// nothing, except that a delivery still removes the delivered batch.
    ///
    /// A result is only acted on once it can be attributed. While the
    /// record of hand-offs can't be read (a locked phone), nothing is
    /// known: the batch and its mark stay, and once the task is gone a
    /// later drain finds the mark without a task and sends the batch again.
    /// The same holds for a delivery whose source can be read from neither
    /// the mark nor the batch: an answer that rejects a source can only be
    /// told from a delivery by knowing which source it was for.
    public func finishBackgroundUpload(_ completion: BackgroundUploadCompletion) async {
        guard let tag = BackgroundUploadTag(completion.tag) else { return }
        let marks: [String: BackgroundUploadMark]
        do {
            marks = try await buffer.backgroundUploadMarks()
        } catch {
            log.notice("Background upload of \(tag.batchId, privacy: .public) finished while its record was unreadable; kept")
            return
        }
        let mark = marks[tag.batchId]
        let current = mark?.tag == completion.tag

        guard case .response(let status, let body) = completion.outcome else {
            if current { try? await buffer.finishBackgroundUpload(tag: tag) }
            log.notice("Background upload of \(tag.batchId, privacy: .public) got no answer; queued again")
            return
        }
        if let failure = DeliveryClassification.failure(status: status, body: body) {
            try? await buffer.finishBackgroundUpload(tag: tag)
            if current { await apply(failure, to: tag, sourceId: mark?.sourceId) }
            return
        }
        let sourceId: String
        do {
            guard let known = try await source(of: tag, mark: mark) else {
                // No mark and no batch: nothing left to settle.
                try? await buffer.finishBackgroundUpload(tag: tag)
                return
            }
            sourceId = known
        } catch {
            log.notice("Background upload of \(tag.batchId, privacy: .public) can't be attributed yet; kept")
            return
        }
        let rejection: PushRejection?
        do {
            rejection = try Self.rejection(in: body, from: tag.endpoint, sourceId: sourceId)
        } catch {
            // Unreadable answer: retried, as in the foreground.
            if current { try? await buffer.finishBackgroundUpload(tag: tag) }
            return
        }
        if let rejection {
            try? await buffer.finishBackgroundUpload(tag: tag)
            guard current else { return }
            backgroundRejections[rejection.sourceId] = rejection.reason
            if rejection.reason == "removed" {
                try? await buffer.remove(id: tag.batchId)
            }
            return
        }
        // Delivered. Removing the batch also clears its mark.
        do {
            try await buffer.remove(id: tag.batchId)
            try? await buffer.finishBackgroundUpload(tag: tag)
        } catch {
            if current {
                try? await buffer.finishBackgroundUpload(tag: tag)
                _ = await notePermanentFailure(id: tag.batchId)
            }
        }
    }

    /// The source a hand-off was for: its mark's, else its batch's. `nil`
    /// when neither is left; throws when the batch can't be read.
    private func source(of tag: BackgroundUploadTag, mark: BackgroundUploadMark?) async throws -> String? {
        if let mark { return mark.sourceId }
        return try await buffer.load(id: tag.batchId)?.sourceId
    }

    /// Act on a background upload's failure as the foreground drain would
    /// on the same answer.
    private func apply(_ failure: DeliveryFailure, to tag: BackgroundUploadTag, sourceId: String?) async {
        switch DeliveryClassification.verdict(for: failure, batchAge: Batch.age(ofId: tag.batchId)) {
        case .reauthorize:
            backgroundUnauthorized = true
        case .blocked:
            if let sourceId { backgroundBlocked.insert(sourceId) }
        case .refuse:
            log.warning(
                "Batch \(tag.batchId, privacy: .public) refused: \(String(describing: failure), privacy: .private)"
            )
            _ = await notePermanentFailure(id: tag.batchId)
        case .retry:
            log.notice("Background upload of \(tag.batchId, privacy: .public) will be retried")
        }
    }

    /// This source's rejection in an ingest answer, read with the same types
    /// the foreground path decodes.
    private static func rejection(
        in body: Data,
        from endpoint: BackgroundUploadEndpoint,
        sourceId: String
    ) throws
        -> PushRejection? {
        let rejected = switch endpoint {
        case .analytics: try JSONDecoder().decode(AnalyticsIngestResponse.self, from: body).rejected
        case .documents: try JSONDecoder().decode(DocumentIngestResponse.self, from: body).rejected
        }
        return rejected.first { $0.sourceId == sourceId }
    }
}
