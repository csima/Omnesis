---
"omnesis": minor
---

Browser capture skips more private pages and redacts credentials. The extension now skips pages with a one-time-code or payment-card field (including inside open shadow roots), multi-factor, API-key, token, Cloudflare Access and token-link paths, and a built-in list of mail, messaging and password-manager sites that applies before any collector connects. The operator's own sites, set once as `webCapture.ownSites` on the gateway, are skipped by every paired browser. Bearer tokens, JWTs, private keys and AWS, GitHub, GitLab, Google, OpenAI, Anthropic, Slack and Stripe keys shown on a page are replaced with `[redacted]` in the browser, and again by the gateway on ingest.
