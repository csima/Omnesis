// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Persistent FIFO queue of pending `Batch`es. Each batch is one JSON
/// file on disk, named by its id (which sorts lexicographically in
/// creation order), so we can read batches in order without keeping
/// any index in memory.
///
/// Survives app kills, iOS suspensions, and device reboots. The actual
/// HealthKit data stays in HealthKit's local database — this buffer
/// holds already-normalised, ready-to-POST payloads that couldn't be
/// delivered immediately.
///
/// Durability model (see design doc §4.4):
///   - HealthKit is the source of truth, but a queued batch is one
///     whose cursor has already moved past it, so the buffer never
///     drops one to make room: a batch that doesn't fit is refused
///     (`Full`), and its page is read again from the same cursor once
///     there is room.
///   - The buffer is a network-coalescing optimisation, not a
///     durability layer. Losing the directory entirely just means a
///     fresh backfill.
///
/// Quarantine:
///   - A batch the gateway will never accept (a payload its schema
///     refuses) or that can no longer be read back off disk would
///     otherwise sit at the head of the FIFO forever: every drain
///     retries it, every drain skips past it, and nothing removes it.
///     Its age grows without bound, so the delivery-health warning it
///     raises latches on permanently while every other batch flows.
///   - So a batch that fails permanently enough times, over enough
///     time (`Config.quarantineAfterAttempts` / `quarantineMinAge`),
///     is moved into `quarantine/` — out of the FIFO, off the health
///     signal, still on disk. `quarantinedCount()` reports them and
///     `discardQuarantined()` is the only thing that deletes them.
///   - Only *permanent* failures count. A gateway that is unreachable
///     must never cost data, however long it stays down.
///
/// Performance model:
///   - The on-disk directory is the source of truth, but every entry
///     into the actor (`enqueue` / `count` / `totalSizeBytes` / …)
///     used to re-walk it. With many queued batches that walk pushed
///     `enqueue` to O(n²) over a drain cycle.
///   - We now cache the sorted-FIFO file list and the running byte
///     total as actor state, lazily rehydrated from disk on first use
///     (and after `OfflineBuffer` is reinstantiated — typical on app
///     cold start). Disk is still the source of truth; if a queued file
///     disappears out-of-band, the next uploader access prunes its cache.
public actor OfflineBuffer {
    private enum LifetimeError: Error {
        case invalidated
    }

    /// A synchronous fence between pairing teardown and actor work already
    /// suspended in a source or network call. Once invalidation returns, no
    /// old owner can touch the shared on-disk directory again.
    private final class Lifetime: @unchecked Sendable {
        private let lock = NSLock()
        private var active = true

        func withActive<T>(_ body: () throws -> T) throws -> T {
            lock.lock()
            defer { lock.unlock() }
            guard active else { throw LifetimeError.invalidated }
            return try body()
        }

        func invalidate() {
            lock.lock()
            defer { lock.unlock() }
            active = false
        }
    }

    public struct Config: Sendable {
        public let maxSizeBytes: Int
        /// The most one source's queued batches may take. A source the
        /// gateway refuses keeps its batches, so without a share of its own
        /// its backlog would fill the buffer and stop every other source.
        public let maxSourceBytes: Int
        /// Alert threshold — warn the UI when the buffer grows past this.
        public let warningSizeBytes: Int
        /// How many permanent delivery failures a single batch may collect
        /// before it is quarantined out of the FIFO.
        public let quarantineAfterAttempts: Int
        /// How long a batch must have been failing before quarantine applies,
        /// measured from its FIRST permanent failure.
        ///
        /// A permanent rejection is usually the gateway refusing a payload it
        /// will never accept — but not always: it can equally be a gateway
        /// that has not caught up to the shape this app version sends, which
        /// an update fixes. This window buys that fix its chance.
        ///
        /// Measured from the first failure rather than from the batch's own
        /// age because the two diverge exactly when it matters. Batches at the
        /// head of a backed-up queue are by construction the oldest, so after
        /// any outage they already satisfy an age test the moment the first
        /// failure arrives — and a drain runs per source, so one foreground
        /// can spend the whole attempt budget in seconds. Timing the run of
        /// failures is what actually holds the window open.
        public let quarantineGrace: TimeInterval
        /// Upper bound on quarantined batches. Each is a page its source's
        /// cursor has moved past, so nothing deletes them but the user's
        /// discard. Once the quarantine holds this many, a batch that runs
        /// out of retries stays queued instead, where it counts toward its
        /// source's backlog and so pauses that source's reading.
        public let maxQuarantinedBatches: Int

        public static let `default` = Config(
            maxSizeBytes: 100 * 1024 * 1024,
            warningSizeBytes: 50 * 1024 * 1024
        )

        public init(
            maxSizeBytes: Int,
            warningSizeBytes: Int,
            quarantineAfterAttempts: Int = 5,
            quarantineGrace: TimeInterval = 6 * 60 * 60,
            maxQuarantinedBatches: Int = 25,
            maxSourceBytes: Int? = nil
        ) {
            self.maxSizeBytes = maxSizeBytes
            self.maxSourceBytes = maxSourceBytes ?? maxSizeBytes / 4
            self.warningSizeBytes = warningSizeBytes
            self.quarantineAfterAttempts = quarantineAfterAttempts
            self.quarantineGrace = quarantineGrace
            self.maxQuarantinedBatches = maxQuarantinedBatches
        }
    }

    /// One batch's run of permanent failures. The count alone is not enough
    /// to decide when to give up — see `Config.quarantineGrace`.
    private struct FailureRun: Codable {
        var attempts: Int
        var firstAt: Date
    }

    private let directory: URL
    private let fileManager: FileManager
    private let config: Config
    private let encoder: JSONEncoder
    private let decoder: JSONDecoder
    private nonisolated let lifetime = Lifetime()

    /// Per-batch run of permanent delivery failures, keyed by batch id.
    /// Persisted (see `attemptsFileURL`) because the process that observes
    /// the failures is rarely the one that reaches the threshold: iOS
    /// relaunches the app between background drains, and in-memory state
    /// would reset on every launch, leaving an undeliverable batch retried
    /// forever — the exact failure this state exists to end.
    private var permanentFailures: [String: FailureRun] = [:]

    /// Sorted FIFO list of file URLs currently on disk (oldest first).
    /// Populated lazily by `ensureCacheLoaded()`; updated in-place on
    /// every mutation. Disk is still the source of truth for the
    /// initial scan + on cache miss in `remove(id:)` / `load(id:)`.
    private var fileURLs: [URL] = []

    /// Running total of all queued file sizes in bytes. Kept in lockstep
    /// with `fileURLs` so `totalSizeBytes()` is O(1).
    private var totalBytes: Int = 0

    /// Sentinel: until the first cache load, we don't know whether the
    /// directory is actually empty or whether we just haven't scanned
    /// yet. Toggled inside `ensureCacheLoaded()`.
    private var cacheLoaded: Bool = false

    /// The source of each queued batch read so far, by batch id.
    private var batchSources: [String: String] = [:]

    /// Batches handed to the background upload queue, keyed by batch id.
    /// `nil` until the sidecar is read; it stays `nil` while the sidecar
    /// can't be read (a locked phone), so "unreadable" is never taken for
    /// "nothing handed off".
    private var backgroundMarks: [String: BackgroundUploadMark]?

    public init(
        directory: URL,
        fileManager: FileManager = .default,
        config: Config = .default
    ) {
        self.directory = directory
        self.fileManager = fileManager
        self.config = config
        let enc = JSONEncoder()
        enc.dateEncodingStrategy = .iso8601
        self.encoder = enc
        let dec = JSONDecoder()
        dec.dateDecodingStrategy = .iso8601
        self.decoder = dec
        try? fileManager.createDirectory(
            at: directory, withIntermediateDirectories: true
        )
        // Self-heal pass: upgrade any batch files (and the directory
        // itself) that carry a weaker protection class than the store's
        // policy. See `ProtectedStore.offlineBuffer` for the class choice.
        ProtectedStore.offlineBuffer.applyProtection(
            toContentsOf: directory, fileManager: fileManager
        )
        ProtectedStore.offlineBuffer.applyBackupExclusion(
            to: directory, fileManager: fileManager
        )
    }

    // MARK: - Public API

    /// Permanently detach this actor from its directory. Pairing teardown
    /// calls this before any out-of-band wipe or replacement buffer is made.
    public nonisolated func invalidate() {
        lifetime.invalidate()
    }

    /// `enqueue` refused a batch: it would take the buffer past
    /// `maxSizeBytes`.
    public struct Full: Error, Equatable {}

    /// Persist a batch to disk. Throws `Full`, and drops nothing, when the
    /// batch would take the buffer past `maxSizeBytes` or its source past
    /// `maxSourceBytes`: every queued batch is one its source's cursor has
    /// already moved past, so dropping one to make room would lose its
    /// samples for good. A source with nothing queued always gets its batch
    /// in, however full the buffer: other sources' backlogs can't stop it,
    /// and an oversized page can't stall its source forever.
    public func enqueue(_ batch: Batch) throws {
        try lifetime.withActive {
            try ProtectedStore.offlineBuffer.requireBackupExclusion(
                to: directory, fileManager: fileManager
            )
            ensureCacheLoaded()
            let data = try encoder.encode(batch)
            let own = bytesQueued(bySource: batch.sourceId)
            guard own == 0
                || (own + data.count <= config.maxSourceBytes && totalBytes + data.count <= config.maxSizeBytes)
            else {
                throw Full()
            }

            let url = fileURL(for: batch.id)
            try data.write(to: url, options: ProtectedStore.offlineBuffer.writingOptions)
            // FIFO order is by filename, and `Batch.makeId` is monotonic, so
            // a fresh batch sorts after every existing one — appending keeps
            // the cache in sorted order without a re-sort. Defensive guard:
            // if for some reason a non-monotonic id arrives (e.g. tests
            // injecting a hand-crafted earlier id), insert in sort position.
            if let last = fileURLs.last, last.lastPathComponent > url.lastPathComponent {
                let idx = fileURLs.firstIndex(where: { $0.lastPathComponent > url.lastPathComponent }) ?? fileURLs.count
                fileURLs.insert(url, at: idx)
            } else {
                fileURLs.append(url)
            }
            totalBytes += data.count
            batchSources[batch.id] = batch.sourceId
        }
    }

    /// Read (but don't remove) the oldest batch. Used by the uploader
    /// which acknowledges via `remove(id:)` after a successful POST.
    public func peekOldest() throws -> Batch? {
        try lifetime.withActive {
            ensureCacheLoaded()
            guard let url = fileURLs.first else { return nil }
            let data = try Data(contentsOf: url)
            return try decoder.decode(Batch.self, from: data)
        }
    }

    /// List all queued batch ids in FIFO order. The uploader uses this to
    /// iterate past an individual failed batch without reloading the same
    /// file over and over (which would happen with `peekOldest` alone).
    public func listIds() throws -> [String] {
        try lifetime.withActive {
            ensureCacheLoaded()
            return fileURLs.map { $0.deletingPathExtension().lastPathComponent }
        }
    }

    /// Load a batch by id, if it still exists.
    public func load(id: String) throws -> Batch? {
        try lifetime.withActive {
            ensureCacheLoaded()
            let url = fileURL(for: id)
            do {
                let data = try Data(contentsOf: url)
                return try decoder.decode(Batch.self, from: data)
            } catch let error as CocoaError where error.code == .fileReadNoSuchFile {
                // Read directly instead of checking `fileExists` first:
                // another owner can remove the file between those operations.
                pruneMissingFile(url, id: id)
                return nil
            }
        }
    }

    /// Delete a batch by id. Called by the uploader after the gateway
    /// confirms ingestion.
    public func remove(id: String) throws {
        try lifetime.withActive {
            ensureCacheLoaded()
            let url = fileURL(for: id)
            let size = (try? sizeOf(url)) ?? 0
            // Clear failure history only once the file is actually gone. A
            // missing file counts as gone and also heals the cached health.
            do {
                try fileManager.removeItem(at: url)
            } catch let error as CocoaError
                where error.code == .fileNoSuchFile || error.code == .fileReadNoSuchFile {
                pruneMissingFile(url, id: id)
                return
            }
            if let idx = fileURLs.firstIndex(of: url) {
                fileURLs.remove(at: idx)
            }
            totalBytes = max(0, totalBytes - size)
            forgetFailures(id: id)
        }
    }

    public func count() throws -> Int {
        try lifetime.withActive {
            ensureCacheLoaded()
            return fileURLs.count
        }
    }

    public func totalSizeBytes() throws -> Int {
        try lifetime.withActive {
            ensureCacheLoaded()
            return totalBytes
        }
    }

    /// True when the buffer has crossed the warning threshold.
    public func isPressure() throws -> Bool {
        try lifetime.withActive {
            ensureCacheLoaded()
            return totalBytes >= config.warningSizeBytes
        }
    }

    /// Age (seconds since creation) of the oldest undrained batch, or nil
    /// if the buffer is empty. Used by `BackgroundTaskCoordinator` to
    /// decide whether to submit an "as soon as possible" drain when the
    /// app backgrounds with stale data still pending.
    ///
    /// Relies on the filename timestamp prefix (`YYYYMMDDHHMMSSmmm-`) —
    /// avoids a filesystem stat per file, which would read the whole
    /// buffer directory every wake-up.
    public func oldestBatchAge() throws -> TimeInterval? {
        try lifetime.withActive {
            ensureCacheLoaded()
            guard let url = fileURLs.first else { return nil }
            return age(ofFileNamed: url.deletingPathExtension().lastPathComponent)
        }
    }

    // MARK: - Quarantine

    /// Record one permanent (non-retryable) delivery failure against `id`.
    ///
    /// Returns true when that failure was the batch's last: it has now been
    /// moved into `quarantine/` and no longer appears in the FIFO, so the
    /// caller should stop counting it as pending. Returns false while the
    /// batch is still within its retry budget, or the quarantine is full —
    /// it stays queued and the next drain tries it again.
    ///
    /// Call this ONLY for failures that repeating cannot fix. A network
    /// error, a 5xx, or a 403 awaiting a scope grant are all states the
    /// world can resolve on its own; feeding them here would delete data
    /// over a long outage.
    @discardableResult
    public func recordPermanentFailure(id: String) throws -> Bool {
        try lifetime.withActive {
            ensureCacheLoaded()
            // A batch that is no longer queued has nothing to quarantine, and
            // keeping a count against its id would leave a ghost entry behind.
            guard fileManager.fileExists(atPath: fileURL(for: id).path) else {
                forgetFailures(id: id)
                return false
            }
            let now = Date()
            var run = permanentFailures[id] ?? FailureRun(attempts: 0, firstAt: now)
            run.attempts += 1
            permanentFailures[id] = run
            // Persisted before the move is attempted: a quarantine that throws
            // must still leave the count on disk, or the batch starts over.
            persistFailures()
            guard run.attempts >= config.quarantineAfterAttempts else { return false }
            guard now.timeIntervalSince(run.firstAt) >= config.quarantineGrace else { return false }
            guard quarantinedURLs().count < config.maxQuarantinedBatches else { return false }
            try quarantine(id: id)
            return true
        }
    }

    /// Number of batches set aside as undeliverable.
    public func quarantinedCount() throws -> Int {
        try lifetime.withActive {
            quarantinedURLs().count
        }
    }

    struct HealthSnapshot: Equatable, Sendable {
        let bufferedBatches: Int
        let oldestBufferedAge: TimeInterval?
        let quarantinedBatches: Int
    }

    /// Read every delivery-health value in one actor turn so UI state cannot
    /// combine observations from different buffer mutations.
    func healthSnapshot() throws -> HealthSnapshot {
        try lifetime.withActive {
            ensureCacheLoaded()
            return HealthSnapshot(
                bufferedBatches: fileURLs.count,
                oldestBufferedAge: fileURLs.first.flatMap {
                    age(ofFileNamed: $0.deletingPathExtension().lastPathComponent)
                },
                quarantinedBatches: quarantinedURLs().count
            )
        }
    }

    /// Delete every quarantined batch. The user's acknowledgement that the
    /// undelivered data is not coming back — nothing else removes these.
    /// Returns how many were deleted.
    @discardableResult
    public func discardQuarantined() throws -> Int {
        try lifetime.withActive {
            // Counts what actually went. Reporting the attempt count would
            // clear the notice only for the next refresh to raise it again.
            var deleted = 0
            for url in quarantinedURLs() where (try? fileManager.removeItem(at: url)) != nil {
                deleted += 1
            }
            return deleted
        }
    }

    // MARK: - Internals

    /// Move a batch out of the FIFO into `quarantine/`. Nothing already
    /// there is evicted to make room (see `Config.maxQuarantinedBatches`).
    private func quarantine(id: String) throws {
        let source = fileURL(for: id)
        let dir = quarantineDirectory()
        try fileManager.createDirectory(at: dir, withIntermediateDirectories: true)

        let size = (try? sizeOf(source)) ?? 0
        let destination = dir.appendingPathComponent(source.lastPathComponent)
        try? fileManager.removeItem(at: destination)
        try fileManager.moveItem(at: source, to: destination)
        if let idx = fileURLs.firstIndex(of: source) {
            fileURLs.remove(at: idx)
        }
        totalBytes = max(0, totalBytes - size)
        forgetFailures(id: id)
    }

    /// Quarantined batch files, oldest first (filenames sort by creation).
    private func quarantinedURLs() -> [URL] {
        let contents = (try? fileManager.contentsOfDirectory(
            at: quarantineDirectory(), includingPropertiesForKeys: nil
        )) ?? []
        return contents
            .filter { $0.pathExtension == "json" }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
    }

    private func quarantineDirectory() -> URL {
        directory.appendingPathComponent("quarantine", isDirectory: true)
    }

    /// Age of a batch from its filename timestamp prefix
    /// ("yyyyMMdd'T'HHmmssSSS-<8-hex>" → the first 18 chars). Matches
    /// `Batch.makeId` — keep them in lockstep.
    private func age(ofFileNamed name: String) -> TimeInterval? {
        guard name.count >= 18 else { return nil }
        guard let created = Self.idFormatter.date(from: String(name.prefix(18))) else { return nil }
        return Date().timeIntervalSince(created)
    }

    private static let idFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyyMMdd'T'HHmmssSSS"
        formatter.timeZone = TimeZone(identifier: "UTC")
        formatter.locale = Locale(identifier: "en_US_POSIX")
        return formatter
    }()

    private func forgetFailures(id: String) {
        batchSources[id] = nil
        forgetBackgroundMark(id: id)
        guard permanentFailures.removeValue(forKey: id) != nil else { return }
        persistFailures()
    }

    /// Sidecar holding `permanentFailures`. Deliberately not a `.json`
    /// file: the FIFO scan claims every `.json` in this directory, so a
    /// sidecar with that extension would be read back as a batch.
    private func attemptsFileURL() -> URL {
        directory.appendingPathComponent("delivery-attempts.state")
    }

    private func persistFailures() {
        let url = attemptsFileURL()
        guard !permanentFailures.isEmpty else {
            try? fileManager.removeItem(at: url)
            return
        }
        guard let data = try? JSONEncoder().encode(permanentFailures) else { return }
        guard (try? ProtectedStore.offlineBuffer.requireBackupExclusion(
            to: directory, fileManager: fileManager
        )) != nil else { return }
        try? data.write(to: url, options: ProtectedStore.offlineBuffer.writingOptions)
    }

    private func loadFailures() {
        // An unreadable or unrecognised sidecar costs a retry budget, not
        // data — every batch simply starts its run over.
        guard let data = try? Data(contentsOf: attemptsFileURL()),
              let decoded = try? JSONDecoder().decode([String: FailureRun].self, from: data) else {
            permanentFailures = [:]
            return
        }
        // Drop counts for batches that are no longer queued — a delivered or
        // quarantined batch must not hand its failure history to a future id.
        let queued = Set(fileURLs.map { $0.deletingPathExtension().lastPathComponent })
        permanentFailures = decoded.filter { queued.contains($0.key) }
    }

    private func fileURL(for id: String) -> URL {
        directory.appendingPathComponent("\(id).json")
    }

    /// Reconcile an entry another owner removed from disk. Normal app
    /// operation has one pairing-scoped buffer actor, but this also heals a
    /// cache created by an interrupted ownership handoff.
    private func pruneMissingFile(_ url: URL, id: String) {
        if let idx = fileURLs.firstIndex(of: url) {
            fileURLs.remove(at: idx)
            totalBytes = fileURLs.reduce(0) { total, fileURL in
                total + ((try? sizeOf(fileURL)) ?? 0)
            }
        }
        forgetFailures(id: id)
    }

    /// Lazy rehydrate from disk. Called by every public method on the
    /// first hit after init (or after explicit invalidation). Subsequent
    /// calls are O(1).
    private func ensureCacheLoaded() {
        if cacheLoaded { return }
        let contents = (try? fileManager.contentsOfDirectory(
            at: directory, includingPropertiesForKeys: [.fileSizeKey]
        )) ?? []
        // Rebuilt from `directory` rather than kept as listed: the listing
        // resolves symlinks (an app container's `/var/…` comes back as
        // `/private/var/…`), and every later lookup — `remove`, quarantine —
        // finds its entry by comparing against `fileURL(for:)`. A mismatch
        // left delivered batches counted as queued after every relaunch.
        let urls = contents
            .filter { $0.pathExtension == "json" }
            .map { fileURL(for: $0.deletingPathExtension().lastPathComponent) }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
        fileURLs = urls
        totalBytes = urls.reduce(0) { acc, url in
            acc + ((try? sizeOf(url)) ?? 0)
        }
        cacheLoaded = true
        // After `fileURLs`, which it is pruned against.
        loadFailures()
    }

    private func sizeOf(_ url: URL) throws -> Int {
        let values = try url.resourceValues(forKeys: [.fileSizeKey])
        return values.fileSize ?? 0
    }
}

// MARK: - Background uploads

extension OfflineBuffer {
    /// Batches handed to the background upload queue, by id. Throws while
    /// the record of them can't be read.
    public func backgroundUploadMarks() throws -> [String: BackgroundUploadMark] {
        try lifetime.withActive {
            ensureCacheLoaded()
            return try loadBackgroundMarks()
        }
    }

    /// Write `body` as the outbox file for `tag` and mark its batch as
    /// handed off, before the task is started. Returns the file to upload.
    /// The file carries this store's own protection class.
    public func prepareBackgroundUpload(_ body: Data, tag: BackgroundUploadTag, sourceId: String) throws -> URL {
        try lifetime.withActive {
            try ProtectedStore.offlineBuffer.requireBackupExclusion(
                to: directory, fileManager: fileManager
            )
            ensureCacheLoaded()
            var marks = try loadBackgroundMarks()
            guard fileURLs.contains(fileURL(for: tag.batchId)) else {
                throw CocoaError(.fileNoSuchFile)
            }
            try fileManager.createDirectory(at: outboxDirectory(), withIntermediateDirectories: true)
            let url = outboxDirectory().appendingPathComponent(tag.outboxFileName)
            try body.write(to: url, options: ProtectedStore.offlineBuffer.writingOptions)
            marks[tag.batchId] = BackgroundUploadMark(tag: tag.description, sourceId: sourceId)
            do {
                try persistBackgroundMarks(marks)
            } catch {
                try? fileManager.removeItem(at: url)
                throw error
            }
            return url
        }
    }

    /// Clear the mark of `tag`'s batch if it still names `tag`, and delete
    /// `tag`'s outbox file either way. Returns whether the mark matched —
    /// false for a task from before a re-pair or one a later hand-off
    /// superseded. Throws while the record can't be read.
    @discardableResult
    public func finishBackgroundUpload(tag: BackgroundUploadTag) throws -> Bool {
        try lifetime.withActive {
            ensureCacheLoaded()
            try? fileManager.removeItem(at: outboxDirectory().appendingPathComponent(tag.outboxFileName))
            var marks = try loadBackgroundMarks()
            guard marks[tag.batchId]?.tag == tag.description else { return false }
            marks.removeValue(forKey: tag.batchId)
            try persistBackgroundMarks(marks)
            return true
        }
    }

    /// Forget every hand-off whose task the system no longer holds, and
    /// every outbox file no live task reads. A batch whose result was lost
    /// goes back to the ordinary queue; sending it again is safe because
    /// ingest is an idempotent upsert. Returns how many marks were cleared.
    ///
    /// A record that doesn't decode is started over once no live task is
    /// for a queued batch — there is then nothing it could have told — and
    /// throws until then.
    @discardableResult
    public func reconcileBackgroundUploads(liveTags: Set<String>) throws -> Int {
        try lifetime.withActive {
            ensureCacheLoaded()
            let marks: [String: BackgroundUploadMark]
            do {
                marks = try loadBackgroundMarks()
            } catch let error as UnrecognisedBackgroundRecord {
                let queued = Set(fileURLs.map { $0.deletingPathExtension().lastPathComponent })
                let out = liveTags.contains { BackgroundUploadTag($0).map { queued.contains($0.batchId) } ?? false }
                if out { throw error }
                try persistBackgroundMarks([:])
                marks = [:]
            }
            let kept = marks.filter { liveTags.contains($0.value.tag) }
            if kept.count != marks.count {
                try persistBackgroundMarks(kept)
            }
            let liveFiles = Set(liveTags.compactMap { BackgroundUploadTag($0)?.outboxFileName })
            let files = (try? fileManager.contentsOfDirectory(
                at: outboxDirectory(), includingPropertiesForKeys: nil
            )) ?? []
            for file in files where !liveFiles.contains(file.lastPathComponent) {
                try? fileManager.removeItem(at: file)
            }
            return marks.count - kept.count
        }
    }

    private func outboxDirectory() -> URL {
        directory.appendingPathComponent("outbox", isDirectory: true)
    }

    /// Sidecar holding `backgroundMarks`; not `.json`, like the attempts one.
    private func backgroundMarksFileURL() -> URL {
        directory.appendingPathComponent("background-uploads.state")
    }

    /// The record of hand-offs exists but doesn't decode.
    struct UnrecognisedBackgroundRecord: Error {}

    /// The marks, read once and pruned to batches still queued. A missing
    /// sidecar is "none". One that can't be read, or reads but doesn't
    /// decode, throws: it says nothing about which batches are out, and
    /// taking it for "none" would send a batch again while its task lives.
    private func loadBackgroundMarks() throws -> [String: BackgroundUploadMark] {
        if let backgroundMarks { return backgroundMarks }
        var marks: [String: BackgroundUploadMark] = [:]
        do {
            let data = try Data(contentsOf: backgroundMarksFileURL())
            do {
                marks = try JSONDecoder().decode([String: BackgroundUploadMark].self, from: data)
            } catch {
                throw UnrecognisedBackgroundRecord()
            }
        } catch let error as CocoaError where error.code == .fileReadNoSuchFile || error.code == .fileNoSuchFile {
            // Nothing handed off yet.
        }
        let queued = Set(fileURLs.map { $0.deletingPathExtension().lastPathComponent })
        let pruned = marks.filter { queued.contains($0.key) }
        backgroundMarks = pruned
        return pruned
    }

    private func persistBackgroundMarks(_ marks: [String: BackgroundUploadMark]) throws {
        let url = backgroundMarksFileURL()
        if marks.isEmpty {
            do {
                try fileManager.removeItem(at: url)
            } catch let error as CocoaError where error.code == .fileNoSuchFile || error.code == .fileReadNoSuchFile {
                // Already none.
            }
        } else {
            try ProtectedStore.offlineBuffer.requireBackupExclusion(to: directory, fileManager: fileManager)
            try JSONEncoder().encode(marks).write(to: url, options: ProtectedStore.offlineBuffer.writingOptions)
        }
        backgroundMarks = marks
    }

    /// A batch that left the queue takes its mark with it. Best-effort: a
    /// mark that can't be cleared now is pruned on the next read, which
    /// drops marks for batches no longer queued.
    private func forgetBackgroundMark(id: String) {
        guard var marks = backgroundMarks, marks.removeValue(forKey: id) != nil else { return }
        if (try? persistBackgroundMarks(marks)) == nil {
            backgroundMarks = nil
        }
    }
}

// MARK: - Backlog by source

extension OfflineBuffer {
    private struct BatchSource: Decodable {
        let sourceId: String
    }

    /// Batches of `sourceId` still queued. One that can't be read (the
    /// phone is locked) counts as the source's own, so a backlog the
    /// buffer can't see holds the source's reading back instead of
    /// letting it run ahead.
    public func pendingCount(sourceId: String) throws -> Int {
        try lifetime.withActive {
            ensureCacheLoaded()
            return fileURLs.count(where: { url in
                let id = url.deletingPathExtension().lastPathComponent
                return (source(ofBatch: id, at: url) ?? sourceId) == sourceId
            })
        }
    }

    /// Bytes `sourceId`'s queued batches take, counting a batch that can't
    /// be read as its own (as `pendingCount` does).
    private func bytesQueued(bySource sourceId: String) -> Int {
        fileURLs.reduce(0) { total, url in
            let id = url.deletingPathExtension().lastPathComponent
            guard (source(ofBatch: id, at: url) ?? sourceId) == sourceId else { return total }
            return total + ((try? sizeOf(url)) ?? 0)
        }
    }

    private func source(ofBatch id: String, at url: URL) -> String? {
        if let known = batchSources[id] { return known }
        guard let data = try? Data(contentsOf: url),
              let read = try? decoder.decode(BatchSource.self, from: data) else { return nil }
        batchSources[id] = read.sourceId
        return read.sourceId
    }
}
