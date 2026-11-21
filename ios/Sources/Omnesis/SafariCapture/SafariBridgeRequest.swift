// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// The gateway requests the Safari extension may ask the app to make: the two
/// capture uploads and the capture settings it shows and edits. The extension
/// applies the same list before asking (`native-contract.ts`), and
/// `Fixtures/safari-bridge-requests.json` holds the cases both are tested
/// against. Anything else is refused here, whatever the extension sends.
public enum SafariBridgeRequest {
    private static let fixed: Set<String> = [
        "POST /documents",
        "POST /analytics/ingest",
        "GET /web-capture-policy",
        "PUT /web-capture-policy/pause",
        "DELETE /web-capture-policy/pause",
        "POST /web-capture-policy/excluded-domains",
    ]

    private static let excludedDomainPrefix = "/web-capture-policy/excluded-domains/"
    private static let maxDomainCharacters = 253

    public static func isAllowed(method: String, path: String) -> Bool {
        if fixed.contains("\(method) \(path)") { return true }
        guard method == "DELETE", path.hasPrefix(excludedDomainPrefix) else { return false }
        let domain = path.dropFirst(excludedDomainPrefix.count)
        guard !domain.isEmpty, domain.count <= maxDomainCharacters else { return false }
        return domain.split(separator: ".", omittingEmptySubsequences: false).allSatisfy { label in
            !label.isEmpty && label.unicodeScalars.allSatisfy(isHostCharacter)
        }
    }

    private static func isHostCharacter(_ scalar: Unicode.Scalar) -> Bool {
        switch scalar {
        case "a" ... "z", "0" ... "9", "-": true
        default: false
        }
    }
}
