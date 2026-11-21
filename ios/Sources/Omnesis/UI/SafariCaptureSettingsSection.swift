// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// Settings for the Safari extension: whether it can reach the gateway, how
/// to turn it on in Safari, and what it reads. Absent from a build that
/// carries no Safari extension.
struct SafariCaptureSettingsSection: View {
    let pairing: Pairing?
    private let fixed: SafariCaptureStatus?
    @State private var status: SafariCaptureStatus
    @State private var showsWhatsSent: Bool

    /// `status` pins the section for previews; the app reads it from the Keychain.
    init(pairing: Pairing?, status: SafariCaptureStatus? = nil, showsWhatsSent: Bool = false) {
        self.pairing = pairing
        fixed = status
        _status = State(initialValue: status ?? SafariCaptureStatus.current(pairing: pairing))
        _showsWhatsSent = State(initialValue: showsWhatsSent)
    }

    var body: some View {
        if status != .unavailable {
            Section {
                Label {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(title)
                        Text(detail)
                            .font(.footnote)
                            .foregroundStyle(Theme.textSecondary)
                    }
                } icon: {
                    Image(systemName: symbol).foregroundStyle(tint)
                }
                if status == .ready {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Turn it on in Safari").font(.subheadline)
                        Text(
                            "Open the Settings app, then Apps, Safari, Extensions and Omnesis. "
                                + "Allow the extension, then choose the websites it may read."
                        )
                        .font(.footnote)
                        .foregroundStyle(Theme.textSecondary)
                    }
                }
                DisclosureGroup(isExpanded: $showsWhatsSent) {
                    PhoneSetupLedgerView(ledger: SafariCaptureStatus.ledger, style: .plain)
                } label: {
                    Text("What's sent")
                        .font(.subheadline)
                        .foregroundStyle(Theme.textPrimary)
                }
                .tint(Theme.textSecondary)
            } header: {
                Text("Safari")
            } footer: {
                Text("Pause capture or exclude a site from the Omnesis button in Safari's page menu.")
            }
            .listRowBackground(Theme.bgSecondary)
            .task(id: pairing) { await refresh() }
        }
    }

    private var title: String {
        switch status {
        case .ready: "Ready to save pages you read"
        case .preparing: "Connecting to your gateway"
        case .unpaired, .unavailable: "Pair this iPhone first"
        }
    }

    private var detail: String {
        switch status {
        case .ready:
            "Pages you stay on in Safari are saved to your index, like the desktop browser extension."
        case .preparing:
            "Safari capture starts once your gateway has issued its credential."
        case .unpaired, .unavailable:
            "Safari capture uses this iPhone's gateway connection."
        }
    }

    private var symbol: String {
        switch status {
        case .ready: "safari.fill"
        case .preparing: "arrow.triangle.2.circlepath"
        case .unpaired, .unavailable: "safari"
        }
    }

    private var tint: Color {
        switch status {
        case .ready: Theme.success
        case .preparing: Theme.warning
        case .unpaired, .unavailable: Theme.textSecondary
        }
    }

    /// The credential is minted in the background after pairing, so a section
    /// opened right then waits for it a short while.
    private func refresh() async {
        guard fixed == nil else { return }
        for _ in 0 ..< 10 {
            status = SafariCaptureStatus.current(pairing: pairing)
            guard status == .preparing else { return }
            try? await Task.sleep(for: .seconds(2))
            if Task.isCancelled { return }
        }
    }
}

#if DEBUG
#Preview("Safari — ready") {
    Form { SafariCaptureSettingsSection(pairing: nil, status: .ready) }
}

#Preview("Safari — what's sent") {
    Form { SafariCaptureSettingsSection(pairing: nil, status: .ready, showsWhatsSent: true) }
}

#Preview("Safari — connecting") {
    Form { SafariCaptureSettingsSection(pairing: nil, status: .preparing) }
}

#Preview("Safari — unpaired") {
    Form { SafariCaptureSettingsSection(pairing: nil, status: .unpaired) }
}
#endif
#endif
