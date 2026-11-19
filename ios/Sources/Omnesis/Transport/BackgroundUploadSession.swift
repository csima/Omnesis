// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// The app's background `URLSession`: one fixed identifier, so a relaunched
/// app reattaches to the tasks an earlier process queued. App-only — the
/// notification-service extension must never create a session with this
/// identifier, since two processes sharing one conflict.
///
/// Trust is the shared session's: every server-trust challenge goes to the
/// delegate `OmnesisURLSession.shared` uses, so pinned, system and rejecting
/// trust behave exactly as on the foreground path.
public final class BackgroundUploadSession: NSObject, BackgroundUploadTransport, @unchecked Sendable {
    public typealias Handler = @Sendable (BackgroundUploadCompletion) async -> Void

    public static let shared = BackgroundUploadSession(
        identifier: "\(Bundle.main.bundleIdentifier ?? "dev.omnesis.ios").uploads"
    )

    public let identifier: String
    /// Answers kept per task; an ingest answer is small, and anything past
    /// this is not one the uploader can read anyway.
    private static let maxResponseBytes = 256 * 1024
    /// Results kept while no uploader is attached to take them.
    private static let maxWaiting = 512

    private let lock = NSLock()
    private var urlSession: URLSession?
    private var handler: Handler?
    private var responses: [Int: Data] = [:]
    /// Results not yet recorded, by tag — waiting for an uploader, or being
    /// recorded now. Counted as live, so a drain running meanwhile doesn't
    /// hand their batches back to the queue.
    private var unrecorded: [String: Int] = [:]
    private var waiting: [BackgroundUploadCompletion] = []
    /// Results handed to the handler and not yet recorded.
    private var recording = 0
    private var eventsCompletion: (() -> Void)?
    /// iOS has delivered every event of a relaunch; `eventsCompletion` is
    /// due once `recording` reaches zero.
    private var eventsFinished = false

    /// Answers server-trust challenges instead of the shared session's
    /// delegate. Only the live E2E sets it, for the scratch gateway's
    /// self-signed certificate.
    private let trustOverride: (any URLSessionDelegate)?

    init(identifier: String, trustOverride: (any URLSessionDelegate)? = nil) {
        self.identifier = identifier
        self.trustOverride = trustOverride
    }

    /// Reattach to this identifier's tasks. Call at launch, so results of
    /// tasks that finished while the app wasn't running are delivered.
    public func activate() {
        _ = session
    }

    /// Route results to `handler`, starting with any that arrived before it
    /// was set. `nil` holds them until the next one.
    public func setHandler(_ handler: Handler?) {
        lock.lock()
        self.handler = handler
        let held = handler == nil ? [] : waiting
        if handler != nil { waiting = [] }
        lock.unlock()
        for completion in held {
            record(completion)
        }
    }

    /// iOS relaunched the app for this session's events; `completion` is
    /// called once every result they carried has been recorded.
    public func handleEvents(completion: @escaping () -> Void) {
        lock.lock()
        eventsCompletion = completion
        lock.unlock()
        activate()
    }

    /// Let queued tasks finish, then release the session. For sessions
    /// made for one test; the app's lives as long as the process.
    func finishAndInvalidate() {
        session.finishTasksAndInvalidate()
    }

    // MARK: - BackgroundUploadTransport

    public func upload(_ request: URLRequest, fromFile file: URL, tag: String) {
        let task = session.uploadTask(with: request, fromFile: file)
        task.taskDescription = tag
        task.resume()
    }

    public func pendingTags() async -> Set<String> {
        let tasks = await session.allTasks
        var tags = Set(tasks.filter { $0.state != .completed }.compactMap(\.taskDescription))
        lock.withLock { tags.formUnion(unrecorded.keys) }
        return tags
    }

    public func cancelAll() async {
        for task in await session.allTasks {
            task.cancel()
        }
    }

    // MARK: - Internals

    private var session: URLSession {
        lock.lock()
        defer { lock.unlock() }
        if let urlSession { return urlSession }
        let configuration = URLSessionConfiguration.background(withIdentifier: identifier)
        configuration.sessionSendsLaunchEvents = true
        configuration.isDiscretionary = false
        let made = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
        urlSession = made
        return made
    }

    private func record(_ completion: BackgroundUploadCompletion) {
        lock.lock()
        guard let handler else {
            if waiting.count < Self.maxWaiting {
                waiting.append(completion)
            } else {
                // Dropped: its batch stays marked until a drain finds no
                // task for it and queues it again.
                release(completion.tag)
            }
            lock.unlock()
            return
        }
        recording += 1
        lock.unlock()
        Task {
            await handler(completion)
            self.finishedRecording(completion.tag)
        }
    }

    private func finishedRecording(_ tag: String) {
        lock.lock()
        release(tag)
        recording -= 1
        let due = takeEventsCompletionIfDue()
        lock.unlock()
        callOnMain(due)
    }

    /// Caller holds `lock`.
    private func takeEventsCompletionIfDue() -> (() -> Void)? {
        guard eventsFinished, recording == 0 else { return nil }
        eventsFinished = false
        defer { eventsCompletion = nil }
        return eventsCompletion
    }

    private func callOnMain(_ completion: (() -> Void)?) {
        guard let completion else { return }
        DispatchQueue.main.async(execute: completion)
    }

    /// Caller holds `lock`.
    private func release(_ tag: String) {
        if let count = unrecorded[tag], count > 1 {
            unrecorded[tag] = count - 1
        } else {
            unrecorded.removeValue(forKey: tag)
        }
    }
}

extension BackgroundUploadSession: URLSessionDataDelegate {
    public func urlSession(
        _ session: URLSession,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        let trust = trustOverride.map { (session, $0) }
            ?? OmnesisURLSession.shared.delegate.map { (OmnesisURLSession.shared, $0) }
        guard let (owner, delegate) = trust,
              delegate.responds(to: #selector(URLSessionDelegate.urlSession(_:didReceive:completionHandler:)))
        else {
            completionHandler(.performDefaultHandling, nil)
            return
        }
        delegate.urlSession?(owner, didReceive: challenge, completionHandler: completionHandler)
    }

    public func urlSession(_: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        lock.lock()
        defer { lock.unlock() }
        var body = responses[dataTask.taskIdentifier] ?? Data()
        guard body.count < Self.maxResponseBytes else { return }
        body.append(data.prefix(Self.maxResponseBytes - body.count))
        responses[dataTask.taskIdentifier] = body
    }

    public func urlSession(_: URLSession, task: URLSessionTask, didCompleteWithError error: (any Error)?) {
        lock.lock()
        let body = responses.removeValue(forKey: task.taskIdentifier) ?? Data()
        guard let tag = task.taskDescription else {
            lock.unlock()
            return
        }
        unrecorded[tag, default: 0] += 1
        lock.unlock()

        let outcome: BackgroundUploadCompletion.Outcome =
            if error == nil, let http = task.response as? HTTPURLResponse {
                .response(status: http.statusCode, body: body)
            } else {
                .failed
            }
        record(BackgroundUploadCompletion(tag: tag, outcome: outcome))
    }

    public func urlSessionDidFinishEvents(forBackgroundURLSession _: URLSession) {
        lock.lock()
        eventsFinished = true
        let due = takeEventsCompletionIfDue()
        lock.unlock()
        callOnMain(due)
    }
}
