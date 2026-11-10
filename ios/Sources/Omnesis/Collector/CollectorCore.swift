// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// The source-agnostic sync orchestrator. Analogous to the desktop
/// collector's `SyncEngine` in `packages/collector/src/sync-engine.ts`,
/// but runs in the iOS app process and is driven by `HKObserverQuery`
/// callbacks + `BGTaskScheduler` instead of a polling interval.
///
/// Per-source sync flow:
///
///   1. Load the persisted cursor from the gateway via `CursorStore`.
///   2. Call `source.sync(cursor:)` repeatedly until `hasMore == false`.
///      Each page is converted into a `Batch` and appended to the
///      `OfflineBuffer`. The cursor advances per-page — so even if the
///      phone dies mid-cycle, the next resume starts where we left off.
///      A cursor saved for a page the buffer later has to drop is not
///      walked back; the cycle publishes a `CoverageClaim` instead.
///   3. Drain the `OfflineBuffer` into the gateway. Batches that fail
///      a transient error stay on disk and are retried by the next
///      drain invocation.
///
/// Concurrency: `CollectorCore` is an actor. One sync per source at a
/// time. Multiple sources are currently driven serially — Phase 3 can
/// introduce parallelism once HealthKit sources are added.
public actor CollectorCore {
    public struct SyncSummary: Equatable, Sendable {
        public let sourceId: String
        public let batches: Int
        public let records: Int
        public let uploaded: Int
        public let remaining: Int
        public let error: String?
        /// Sources whose batches the gateway refused with 403 during the drain
        /// this sync triggered, or `nil` when no drain observed the buffer.
        ///
        /// Not necessarily `sourceId` — a drain walks the whole buffer, so
        /// syncing one source can reveal that a different one is unauthorized.
        /// Reported per pass so the UI reflects the current state rather than
        /// accumulating stale entries; `nil` means "no evidence", which a
        /// caller must not confuse with "nothing blocked".
        public let blocked: [String]?
    }

    public enum State: Equatable, Sendable {
        case idle
        case syncing(sourceId: String)
        case error(sourceId: String, message: String)
    }

    /// Live sync progress snapshot. Emitted via `onProgress` each time a
    /// page completes so the UI can show a meaningful counter instead
    /// of an opaque "Syncing…" spinner. `nil` means idle.
    public struct Progress: Equatable, Sendable {
        public let sourceId: String
        public let displayName: String
        public let records: Int
        public let pages: Int
        public let batchesBuffered: Int
    }

    public typealias ProgressHandler = @Sendable (Progress?) async -> Void

    /// What a sync cycle can say about the history the phone still holds for
    /// a source, published beside that cycle's status.
    ///
    /// A cycle that kept everything it captured makes no claim at all: most
    /// sources bound no history, so a coverage line on a healthy source warns
    /// about nothing, and `complete` is a promise a collector reading one
    /// upstream page at a time is in no position to make.
    public struct CoverageClaim: Equatable, Sendable {
        public let coverage: HistoryCoverage
        /// One sentence for the operator, rendered verbatim by every client.
        public let detail: String

        public init(coverage: HistoryCoverage, detail: String) {
            self.coverage = coverage
            self.detail = detail
        }
    }

    /// Lifecycle boundary of a per-source sync. The AppStore forwards
    /// these to the DeviceSocket as `sync.status` events so the
    /// gateway's SyncStatusRegistry tracks iOS-side syncs the same way
    /// it tracks the desktop collector's.
    public enum Lifecycle: Equatable, Sendable {
        case started(sourceId: String, displayName: String, startedAt: Date)
        case progress(sourceId: String, displayName: String, records: Int)
        /// `coverage` is present only when the cycle has something to say
        /// about the history behind it; absent is the healthy answer.
        case completed(
            sourceId: String,
            displayName: String,
            records: Int,
            completedAt: Date,
            coverage: CoverageClaim?
        )
        case error(sourceId: String, displayName: String, message: String)
        /// A run ended without succeeding or failing (for example, iOS
        /// cancelled a background request). Clears a prior `started` event
        /// without recording a successful update.
        case idle(sourceId: String, displayName: String)
        /// The gateway rejected pushes for this source — it was removed or
        /// paused in Omnesis (`reason` is `"removed"` / `"paused"`). Not a sync
        /// status; the AppStore acts on it (disable a removed source locally).
        case sourceRejected(sourceId: String, reason: String)
    }

    public typealias LifecycleHandler = @Sendable (Lifecycle) async -> Void
    private let gateway: GatewayClient
    private let buffer: OfflineBuffer
    private let cursorStore: CursorStore
    private let uploader: Uploader
    private let sources: [any OmnesisSource]
    private let onProgress: ProgressHandler?
    private let onLifecycle: LifecycleHandler?
    private let log = AppLog.make(category: "collector.core")
    private let prepareSource: (@Sendable (String, SourceMultiDeviceMode) async throws -> Void)?
    private let budget: (any ExecutionBudget)?
    private var preparedSourceIds: Set<String> = []

    private var inFlight: Set<String> = []
    /// One coalesced follow-up per source when an observer wakes while that
    /// source is already running. Dropping that wake can strand data that
    /// arrived after the active pass took its input snapshot.
    private var pendingReruns: Set<String> = []
    /// Callers of `sync(sourceId:awaitingFollowUp: true)` that found the
    /// source already syncing, waiting for the pass that covers their request.
    private var followUpWaiters: [String: [CheckedContinuation<SyncSummary?, Never>]] = [:]
    private var directDrains = 0
    private var lastSyncAt: [String: Date] = [:]
    private var acceptingSyncs = true
    private var quiescenceWaiters: [CheckedContinuation<Void, Never>] = []

    public init(
        gateway: GatewayClient,
        buffer: OfflineBuffer,
        cursorStore: CursorStore,
        uploader: Uploader,
        sources: [any OmnesisSource],
        prepareSource: (@Sendable (String, SourceMultiDeviceMode) async throws -> Void)? = nil,
        budget: (any ExecutionBudget)? = nil,
        onProgress: ProgressHandler? = nil,
        onLifecycle: LifecycleHandler? = nil
    ) {
        self.gateway = gateway
        self.buffer = buffer
        self.cursorStore = cursorStore
        self.uploader = uploader
        self.sources = sources
        self.prepareSource = prepareSource
        self.budget = budget
        self.onProgress = onProgress
        self.onLifecycle = onLifecycle
    }

    /// Sync every registered source in sequence, then drain the buffer.
    public func syncAll() async -> [SyncSummary] {
        guard acceptingSyncs else { return [] }
        var results: [SyncSummary] = []
        for source in sources {
            guard acceptingSyncs else { break }
            await results.append(syncOne(source: source))
        }
        await emitProgress(nil)
        return results
    }

    /// Snapshot of the sources driven by this core. Used at launch to
    /// register iOS-local sources (Apple Health) with the gateway so they
    /// appear in the portal.
    public func registeredSourceIds() -> [String] {
        sources.map(\.id)
    }

    /// Sync a single source by id — used by HealthKit observer callbacks
    /// to target a specific sample type efficiently.
    ///
    /// A call that finds the source already syncing queues one follow-up pass,
    /// which the running sync performs before it returns. By default the call
    /// returns at once; with `awaitingFollowUp` it returns when that pass is
    /// done, which is what a background wake needs before it reports itself
    /// handled — the data that woke it may have arrived after the running
    /// pass read its page.
    public func sync(sourceId: String, awaitingFollowUp: Bool = false) async -> SyncSummary? {
        guard acceptingSyncs else { return nil }
        guard let source = sources.first(where: { $0.id == sourceId }) else {
            log.warning("No registered source with id \(sourceId, privacy: .private)")
            return nil
        }
        if awaitingFollowUp, inFlight.contains(source.id) {
            pendingReruns.insert(source.id)
            return await withCheckedContinuation { continuation in
                followUpWaiters[source.id, default: []].append(continuation)
            }
        }
        let summary = await syncOne(source: source)
        await emitProgress(nil)
        return summary
    }

    /// Whether `sourceId` still has history to read, by its last saved
    /// cursor. False for a source this core doesn't drive, and when the
    /// cursor can't be read.
    public func hasHistoryPending(sourceId: String) async -> Bool {
        guard let source = sources.first(where: { $0.id == sourceId }) else { return false }
        do {
            return try await source.hasHistoryPending(cursor: cursorStore.load(for: sourceId))
        } catch {
            return false
        }
    }

    /// Reads `sourceId`'s pending history for as long as the calling task
    /// runs: passes back to back until none is left, a pass fails or reads
    /// nothing (the phone locked, the gateway out of reach — a pass only
    /// ends empty-handed with history pending when it can't read it), or
    /// the task is cancelled, which stops the pass at a page boundary.
    /// Returns whether history is still pending.
    public func readPendingHistory(sourceId: String, maxPasses: Int = 50) async -> Bool {
        for _ in 0 ..< maxPasses {
            guard acceptingSyncs, !Task.isCancelled, await hasHistoryPending(sourceId: sourceId) else { break }
            let summary = await sync(sourceId: sourceId, awaitingFollowUp: true)
            guard let summary, summary.error == nil, summary.batches > 0 else { break }
        }
        return await hasHistoryPending(sourceId: sourceId)
    }

    /// Drain the offline buffer without pulling new data. Useful after
    /// network reconnects or at app launch before anything else runs.
    public func drainPending() async -> Uploader.Stats? {
        guard acceptingSyncs else { return nil }
        directDrains += 1
        defer {
            directDrains -= 1
            resumeQuiescenceWaitersIfReady()
        }
        do {
            let stats = try await uploader.drain()
            await emitRejections(stats)
            return stats
        } catch {
            log.error("Drain failed: \(String(describing: error), privacy: .private)")
            return nil
        }
    }

    public func lastSync(sourceId: String) -> Date? {
        lastSyncAt[sourceId]
    }

    public func bufferCount() async -> Int {
        await (try? buffer.count()) ?? 0
    }

    /// Stop admitting new source work and wait until every admitted sync has
    /// completed its source call, buffer enqueue, cursor save, and drain. A
    /// replacement collector is installed only after this returns, so an old
    /// authorization generation can never write after its successor.
    public func retireAndWait() async {
        acceptingSyncs = false
        guard !inFlight.isEmpty || directDrains > 0 else { return }
        await withCheckedContinuation { continuation in
            quiescenceWaiters.append(continuation)
        }
    }

    private func emitProgress(_ progress: Progress?) async {
        guard let onProgress else { return }
        await onProgress(progress)
    }

    private func emitLifecycle(_ event: Lifecycle) async {
        guard let onLifecycle else { return }
        await onLifecycle(event)
    }

    /// Emit a `.sourceRejected` lifecycle for every source the drain pass found
    /// removed/paused, so the AppStore can disable a removed source locally.
    private func emitRejections(_ stats: Uploader.Stats?) async {
        guard let stats else { return }
        for rejection in stats.rejected {
            await emitLifecycle(.sourceRejected(sourceId: rejection.sourceId, reason: rejection.reason))
        }
    }

    // MARK: - Internals

    private func syncOne(source: any OmnesisSource) async -> SyncSummary {
        guard acceptingSyncs else {
            return await SyncSummary(
                sourceId: source.id,
                batches: 0,
                records: 0,
                uploaded: 0,
                remaining: bufferCount(),
                error: nil,
                blocked: nil
            )
        }
        if inFlight.contains(source.id) {
            pendingReruns.insert(source.id)
            log.debug("Queue one rerun for \(source.id, privacy: .private) — already syncing")
            return await SyncSummary(
                sourceId: source.id,
                batches: 0,
                records: 0,
                uploaded: 0,
                remaining: bufferCount(),
                error: nil,
                blocked: nil
            )
        }
        inFlight.insert(source.id)
        var summary = await runPass(source: source)
        // Wakes that arrived while the pass ran coalesce into one more pass,
        // run here rather than in a task of its own so it stays inside
        // whatever is keeping this one alive (a background-task assertion, an
        // unanswered HealthKit wake). Expiration cancels the caller, and a
        // wake with too little time left leaves the samples for the next one.
        while pendingReruns.remove(source.id) != nil,
              acceptingSyncs,
              !Task.isCancelled,
              await budget?.allows(ExecutionMargin.page) ?? true {
            summary = await runPass(source: source)
        }
        pendingReruns.remove(source.id)
        inFlight.remove(source.id)
        let waiters = followUpWaiters.removeValue(forKey: source.id) ?? []
        waiters.forEach { $0.resume(returning: summary) }
        resumeQuiescenceWaitersIfReady()
        return summary
    }

    // One pass over a source: pages until it has nothing more, the page cap,
    // or the time left runs short, then a drain. Sync state, cursor, buffer,
    // and lifecycle publication must remain one ordered operation.
    // swiftlint:disable:next function_body_length
    private func runPass(source: any OmnesisSource) async -> SyncSummary {
        var batchesWritten = 0
        var batchesDropped = 0
        var recordsProduced = 0
        var itemsProcessed = 0
        var errorMessage: String?
        var wasCancelled = false
        var pages = 0
        var outOfTime = false
        let startedAt = Date()

        await emitProgress(Progress(
            sourceId: source.id,
            displayName: source.displayName,
            records: 0,
            pages: 0,
            batchesBuffered: bufferCount()
        ))
        await emitLifecycle(.started(
            sourceId: source.id,
            displayName: source.displayName,
            startedAt: startedAt
        ))

        do {
            if !preparedSourceIds.contains(source.id) {
                try await prepareSource?(source.id, source.multiDeviceMode)
                preparedSourceIds.insert(source.id)
            }
            var cursor = try await source.cursorForNewPass(cursorStore.load(for: source.id, refresh: true))
            // Cap to avoid runaway loops while a malformed source keeps
            // claiming hasMore=true.
            let maxPages = 200
            while pages < maxPages {
                // The task running the pass was expired (a background task's
                // time is up): stop before the next page. Every page before
                // it is buffered and its cursor saved.
                if Task.isCancelled {
                    wasCancelled = true
                    break
                }
                // A page cut off by suspension is redone from the same cursor
                // on the next wake; not starting it saves the wake's time for
                // the drain below. Everything before it is buffered and saved.
                guard await budget?.allows(ExecutionMargin.page) ?? true else {
                    outOfTime = true
                    log.notice(
                        "Pausing \(source.id, privacy: .private) after \(pages, privacy: .public) pages: too little background time left"
                    )
                    break
                }
                let result = try await source.sync(cursor: cursor)
                pages += 1

                if !result.records.isEmpty || !result.deletedIds.isEmpty || !result.documents.isEmpty {
                    let batch = Batch(
                        id: Batch.makeId(),
                        sourceId: source.id,
                        multiDeviceMode: source.multiDeviceMode,
                        tableName: result.tableName,
                        records: result.records,
                        schema: result.schema,
                        deletedIds: result.deletedIds,
                        documents: result.documents,
                        createdAt: Date()
                    )
                    let evicted = try await buffer.enqueue(batch)
                    try await source.didBuffer(result)
                    if evicted > 0 {
                        batchesDropped += evicted
                        log.warning(
                            "Buffer eviction: dropped \(evicted, privacy: .public) old batches to make room for \(source.id, privacy: .private)"
                        )
                    }
                    batchesWritten += 1
                    recordsProduced += result.records.count
                    // A page may represent the same item as both an analytics
                    // row and a searchable document. Count the larger plane so
                    // documents-only sources such as Photos report real work
                    // without double-counting mixed pages such as workouts.
                    itemsProcessed += max(result.records.count, result.documents.count)
                }

                cursor = result.cursor
                try await cursorStore.save(
                    sourceId: source.id,
                    cursor: result.cursor,
                    label: source.displayName
                )

                await emitProgress(Progress(
                    sourceId: source.id,
                    displayName: source.displayName,
                    records: itemsProcessed,
                    pages: pages,
                    batchesBuffered: bufferCount()
                ))
                await emitLifecycle(.progress(
                    sourceId: source.id,
                    displayName: source.displayName,
                    records: itemsProcessed
                ))

                if !result.hasMore {
                    break
                }
            }
            if !wasCancelled {
                lastSyncAt[source.id] = Date()
            }
        } catch {
            // NSURLErrorCancelled (-999) means iOS suspended the process
            // mid-request (typical when an HKObserver background wake
            // ran out of its time budget). The data we'd already
            // produced may have made it to the gateway or may not have;
            // either way HK's anchored cursor stays put if its save
            // didn't go through, and the upload is idempotent on the
            // gateway via primary keys. Treat as transient: don't
            // surface as a sync error (which would flip the source to
            // ERROR in the portal + CLI). Next observer wake or
            // foreground sync resumes cleanly. A `CancellationError` is the
            // same story told by the task: a background task iOS expired.
            let nsError = error as NSError
            let isCancelled = error is CancellationError
                || (nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled)
            if isCancelled {
                wasCancelled = true
                log
                    .notice(
                        // swiftlint:disable:next line_length
                        "Sync for \(source.id, privacy: .private) cancelled mid-request (likely background suspension); leaving state unchanged for retry"
                    )
            } else {
                errorMessage = String(describing: error)
                log.error("Sync failed for \(source.id, privacy: .private): \(String(describing: error), privacy: .private)")
            }
        }

        // Drain regardless — batches from prior cycles might be waiting —
        // unless the task was expired, when every request would be cut off.
        let stats: Uploader.Stats? = Task.isCancelled ? nil : try? await uploader.drain()
        await emitRejections(stats)
        let remaining: Int = if let stats {
            stats.remaining
        } else {
            await bufferCount()
        }

        if let errorMessage {
            await emitLifecycle(.error(
                sourceId: source.id,
                displayName: source.displayName,
                message: errorMessage
            ))
        } else if wasCancelled || (outOfTime && pages == 0) {
            // Nothing happened this pass that a status should claim.
            await emitLifecycle(.idle(sourceId: source.id, displayName: source.displayName))
        } else {
            await emitLifecycle(.completed(
                sourceId: source.id,
                displayName: source.displayName,
                records: itemsProcessed,
                completedAt: Date(),
                coverage: Self.coverageClaim(droppedBatches: batchesDropped)
            ))
        }

        return SyncSummary(
            sourceId: source.id,
            batches: batchesWritten,
            records: recordsProduced,
            uploaded: stats?.uploaded ?? 0,
            remaining: remaining,
            error: errorMessage,
            blocked: stats?.blocked
        )
    }

    /// The claim a cycle makes once the offline buffer had to drop batches to
    /// stay inside its size limit.
    ///
    /// The buffer is where a page waits between capture and upload, and the
    /// gateway's cursor for the source moves on as soon as a page is written
    /// there. Dropping the oldest batches therefore drops data the source will
    /// never offer again, because the cursor is already past it. Capturing into
    /// a full buffer is still the better trade — a phone that stopped capturing
    /// would fall behind everything, not just its oldest pages — so the gap is
    /// reported rather than prevented.
    private static func coverageClaim(droppedBatches: Int) -> CoverageClaim? {
        guard droppedBatches > 0 else { return nil }
        return CoverageClaim(
            coverage: .partial,
            detail: """
            This device ran out of room for data waiting to reach Omnesis and dropped \
            the oldest of it, so some history is missing. Re-sync this source to fill the gap.
            """
        )
    }

    private func resumeQuiescenceWaitersIfReady() {
        guard inFlight.isEmpty, directDrains == 0, !acceptingSyncs else { return }
        let waiters = quiescenceWaiters
        quiescenceWaiters.removeAll()
        waiters.forEach { $0.resume() }
    }
}
