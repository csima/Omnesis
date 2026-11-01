---
"omnesis": minor
---

Browser capture skips more private pages and redacts credentials. The extension now skips pages with a one-time-code or payment-card field (including inside open shadow roots), multi-factor, API-key, token, Cloudflare Access and token-link paths, and a built-in list of mail, messaging and password-manager sites that applies before any collector connects. The operator's own sites, set once as `webCapture.ownSites` on the gateway, are skipped by every paired browser. Bearer tokens, JWTs, private keys and AWS, GitHub, GitLab, Google, OpenAI, Anthropic, Slack and Stripe keys shown on a page are replaced with `[redacted]` in the browser, and again by the gateway on ingest.

The gateway also judges every captured page and visit against the capture settings on ingest, redacts their addresses and metadata, refuses `web:<account>` source ids from browser tokens, and re-redacts web pages and page visits stored before this release once, in the background after upgrade, with the credential-shape rules only. A captured URL that carried an `access_token`, `id_token`, `refresh_token`, `session_token`, `csrf_token`, `auth_token` or Google signed-URL parameter, in the query or in a fragment's query, gets a new identity.
