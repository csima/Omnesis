// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import TurndownService from "turndown";
import { tables } from "turndown-plugin-gfm";
import { redactSecrets, redactShapedSecrets } from "@omnesis/provider-web/redact-secrets";

/**
 * The redaction corpus, against real Turndown output where a page would
 * produce it: credentials that must be caught, and developer pages and
 * configuration that talk about credentials without holding one, which must
 * come back exactly as they went in. Every credential is invented and
 * assembled at run time from fragments.
 */

const j = (...p: string[]) => p.join("");
const b64 = (n: number) => "Q7rT2mX9pL4vN8kBzW3yH6fJ1cD5gS0a".repeat(Math.ceil(n / 32)).slice(0, n);
const jwt = j(
  "ey",
  "JhbGciOiJIUzI1NiJ9",
  ".",
  "ey",
  "JzdWIiOiJtYXlhIn0",
  ".",
  "c2lnbmF0dXJlLXRlc3QtdmFsdWU",
);
const pemBody = [b64(64), b64(64), b64(64), "Q7rT2mX9pL4v=="];
const pem = (lines: string[], sep = "\n", prefix = "") =>
  [j("-----BEGIN ", "PRIVATE KEY-----"), ...lines, j("-----END ", "PRIVATE KEY-----")]
    .map((l) => prefix + l)
    .join(sep);
const td = new TurndownService({
  headingStyle: "atx",
  bulletListMarker: "-",
  codeBlockStyle: "fenced",
});
td.use(tables);

const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const sha1 = "9fceb02d0ae598e95dc970b74767f19372d61af8";
const sha256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

const MUST_CATCH: Array<[string, string]> = [
  ["jwt", `token ${jwt} here`],
  ["jwt in md escaped", td.turndown(`<p>id: ${jwt}</p>`)],
  ["ghp", j("ghp_", b64(36))],
  ["ghp turndown", td.turndown(`<p>Use ${j("ghp_", b64(36))} now</p>`)],
  ["github_pat", j("github_pat_", "11ABCDEFG0", b64(12), "_", b64(59))],
  [
    "github_pat turndown",
    td.turndown(`<p>${j("github_pat_", "11ABCDEFG0", b64(12), "_", b64(59))}</p>`),
  ],
  ["sk-proj", j("sk-proj-", b64(48))],
  ["sk-ant", j("sk-ant-api03-", b64(80), "-AA")],
  ["sk-ant admin", j("sk-ant-admin01-", b64(80))],
  ["sk legacy", j("sk-", b64(48))],
  ["AKIA", j("AKIA", "IOSFODNN7EXAMPLE")],
  ["aws secret env", j("AWS_SECRET_ACCESS_KEY=", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY")],
  [
    "aws secret json",
    j('"aws_secret_access_key": "', "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", '"'),
  ],
  [
    "aws secret only value in ini",
    j("aws_secret_access_key = ", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"),
  ],
  ["pem plain", pem(pemBody)],
  ["pem blockquote", pem(pemBody, "\n", "> ")],
  ["pem indent", pem(pemBody, "\n", "    ")],
  ["pem CRLF", pem(pemBody, "\r\n")],
  ["pem br turndown", td.turndown(`<p>${pem(pemBody, "<br>")}</p>`)],
  ["pem trailing space lines", pem(pemBody, " \n")],
  [
    "pem div per line turndown",
    td.turndown(
      pem(pemBody)
        .split("\n")
        .map((l) => `<div>${l}</div>`)
        .join(""),
    ),
  ],
  ["pem in li", td.turndown(`<ul><li><pre>${pem(pemBody)}</pre></li></ul>`)],
  ["pem RSA", pem(pemBody).replace(/PRIVATE KEY/g, "RSA PRIVATE KEY")],
  [
    "pem OPENSSH",
    pem(pemBody.map((l) => l.slice(0, 70))).replace(/PRIVATE KEY/g, "OPENSSH PRIVATE KEY"),
  ],
  [
    "pem encrypted",
    [
      j("-----BEGIN ", "RSA PRIVATE KEY-----"),
      "Proc-Type: 4,ENCRYPTED",
      "DEK-Info: AES-128-CBC,0123456789ABCDEF0123456789ABCDEF",
      "",
      ...pemBody,
      j("-----END ", "RSA PRIVATE KEY-----"),
    ].join("\n"),
  ],
  ["pem one line", pem(pemBody, " ")],
  ["pem tab-indented in md quote list", pem(pemBody, "\n", ">\t")],
  ["pem line wrapped at 76 with base64 ending =", pem([b64(76), b64(40) + "="])],
  [
    "pgp",
    [
      j("-----BEGIN PGP ", "PRIVATE KEY BLOCK-----"),
      "",
      ...pemBody,
      "=Ab1C",
      j("-----END PGP ", "PRIVATE KEY BLOCK-----"),
    ].join("\n"),
  ],
  ["slack xoxb", j("xoxb-", "123456789012-1234567890123-", b64(24))],
  [
    "slack xoxp",
    j("xoxp-", "123456789012-1234567890123-1234567890123-", "0123456789abcdef0123456789abcdef"),
  ],
  ["slack xapp", j("xapp-1-", "A0123456789-1234567890123-", "0123456789abcdef")],
  ["slack webhook", j("https://hooks.slack.com/services/", "T00000000/B00000000/", b64(24))],
  [
    "slack webhook md-escaped",
    td.turndown(
      `<p>${j("https://hooks.slack.com/services/", "T00000000/B00000000/", b64(24))}</p>`,
    ),
  ],
  ["postgres url", "postgres://jordan:Xk9mQ2vLp@db.example.com:5432/app"],
  ["postgresql url w/ special", "postgresql://jordan:Xk9%23mQ2vLp@db.example.com/app"],
  ["mongodb+srv", "mongodb+srv://jordan:Xk9mQ2vLp@cluster0.example.net/app"],
  ["redis no user", "redis://:Xk9mQ2vLp@cache.example.com:6379"],
  ["url pass contains @", "https://jordan:Xk9@mQ2vLp@db.example.com/"],
  ["password= assign", "password=Xk9#mQ2vLp"],
  ["PASSWORD env", "DB_PASSWORD=Xk9#mQ2vLp"],
  ["password: yaml", "password: Xk9#mQ2vLp"],
  ["password json", '{"password":"Xk9#mQ2vLp"}'],
  ["password lower letters+digits", "password=hunter2abc"],
  ["password all lower long", "password=correcthorsebatterystaple"],
  ["password w/ quotes in value", "password='Xk9#mQ2(vLp'"],
  ["password value with paren", "password=Xk9(mQ2vLp"],
  ["password value ending with )", "password=Xk9mQ2vLp)"],
  ["password value starts with $", "password=$Xk9mQ2vLp"],
  ["password value starts with #", "password=#Xk9mQ2vLp"],
  ["password value starts with !", "password=!Xk9mQ2vLp"],
  ["password value starts with @", "password=@Xk9mQ2vLp"],
  ["password value with {{", "password=Xk9{{mQ2vLp"],
  ["password 7 chars", "password=Xk9#mQ2"],
  ["password digits only", "pin_password=48213957"],
  ["md bold password", "**Password:** Xk9#mQ2vLp"],
  ["password with spaces quoted", 'password: "Xk9 mQ2 vLp"'],
  ["Authorization header", "Authorization: Bearer abcDEF123456ghiJKL"],
  ["authorization basic", "Authorization: Basic bWF5YTpzZWNyZXQ="],
  ["curl -H", "curl -H 'Authorization: Bearer abcDEF123456ghiJKL' https://api.example.com"],
  ["curl -u", "curl -u jordan:Xk9mQ2vLp https://api.example.com"],
  ["stripe sk_live", j("sk_live_", b64(24))],
  ["stripe rk_live", j("rk_live_", b64(24))],
  ["whsec", j("whsec_", b64(32))],
  ["google AIza", j("AIza", "SyD", b64(32))],
  ["gitlab", j("glpat-", b64(20))],
  ["npm", j("npm_", b64(36))],
  ["hf", j("hf_", b64(34))],
  ["SendGrid", j("SG.", b64(22), ".", b64(43))],
  ["telegram", j("123456789:AA", b64(33))],
  ["discord", j("MTA", b64(23), ".", "G1a2B3", ".", b64(27))],
  ["azure secret", j("abc8Q~", b64(34))],
  [
    "AccountKey",
    j(
      "DefaultEndpointsProtocol=https;AccountName=demo;AccountKey=",
      b64(86),
      "==;EndpointSuffix=core.windows.net",
    ),
  ],
  ["hidden in token", j("gh", "\u200B", "p_", b64(36))],
  ["split code spans 2", "`" + j("ghp_", b64(18)) + "``" + b64(18) + "`"],
  ["split code spans 3", "`" + j("ghp_", b64(12)) + "``" + b64(12) + "``" + b64(12) + "`"],
  ["token in URL query", j("https://example.com/cb?access_token=", b64(30))],
  [
    "k8s secret data",
    "apiVersion: v1\nkind: Secret\ndata:\n  password: WGs5I21RMnZMcA==\n  api-key: UTdyVDJtWDlwTDR2TjhrQg==",
  ],
  ["dotenv quoted", 'STRIPE_SECRET="Xk9mQ2vLpZ"'],
  ["ini password", "[db]\npassword = Xk9#mQ2vLp"],
  ["TOML password", 'password = "Xk9#mQ2vLp"'],
  ["php define", "define('DB_PASSWORD', 'Xk9#mQ2vLp');"],
  ["python kwarg", 'connect(user="jordan", password="Xk9#mQ2vLp")'],
  ["js object", "const cfg = { apiKey: 'Xk9mQ2vLpZt7' };"],
  ["XML", "<password>Xk9#mQ2vLp</password>"],
  ["java props", "spring.datasource.password=Xk9#mQ2vLp"],
  ["docker -e", "docker run -e POSTGRES_PASSWORD=Xk9#mQ2vLp postgres"],
  ["table password", "| User | Password |\n| --- | --- |\n| jordan | Xk9#mQ2vLp |"],
  [
    "table api key (pipe in value?)",
    "| Service | API key |\n|---|---|\n| demo | Q7rT2mX9pL4vN8kB |",
  ],
];

const DEVELOPER_PAGES: Array<[string, string]> = [
  [
    "go",
    "func login(user, password string) error {\n\ttoken, err := auth.Issue(user)\n\tif err != nil {\n\t\treturn err\n\t}\n\tsecret := cfg.Secret\n\treturn nil\n}",
  ],
  [
    "go struct tags",
    'type Config struct {\n\tPassword string `json:"password" yaml:"password"`\n\tAPIKey   string `env:"API_KEY,required"`\n}',
  ],
  [
    "rust",
    'let password: String = read_password()?;\nlet token = Token::new(&secret_key);\nlet api_key: Option<String> = env::var("API_KEY").ok();',
  ],
  [
    "java",
    'String password = request.getParameter("password");\nprivate static final String SECRET_KEY_HEADER = "X-Secret-Key";\nTokenResponse token = client.exchange(code);',
  ],
  [
    "csharp",
    'public string Password { get; set; }\nvar token = await _tokenService.CreateAsync(userId);\noptions.ClientSecret = Configuration["Auth:ClientSecret"];',
  ],
  [
    "ruby",
    'user.password = params[:password]\nconfig.secret_key_base = ENV.fetch("SECRET_KEY_BASE")\ntoken = SecureRandom.hex(32)',
  ],
  [
    "php",
    '$password = $_POST["password"];\n$token = bin2hex(random_bytes(16));\n$apiKey = getenv("API_KEY");',
  ],
  [
    "shell",
    'read -s -p "Password: " password\nexport API_TOKEN=$(vault kv get -field=token secret/app)\ncurl -H "Authorization: Bearer $API_TOKEN" https://api.example.com',
  ],
  [
    "sql",
    "CREATE TABLE users (id INT, password_hash VARCHAR(255), api_token CHAR(64));\nSELECT token FROM sessions WHERE user_id = 42;",
  ],
  [
    "python typed",
    "def login(username: str, password: str) -> Token:\n    token = issue_token(username)\n    return token",
  ],
  [
    "python dataclass",
    "@dataclass\nclass Settings:\n    secret_key: str = field(repr=False)\n    api_token: SecretStr = SecretStr('')",
  ],
  [
    "ts interface",
    "interface Credentials {\n  password?: string;\n  accessToken: AccessToken;\n  refreshToken: string | null;\n}",
  ],
  [
    "ts generic",
    "const tokenMap: Map<string, TokenInfo> = new Map();\nconst secretKey = process.env.SECRET_KEY!;",
  ],
  [
    "kotlin",
    "val password: CharArray = console.readPassword()\nval token = tokenProvider.issue(userId = 42)",
  ],
  [
    "swift",
    'let password: String = keychain["password"] ?? ""\nlet token = try await auth.refreshToken()',
  ],
  [
    "md api ref",
    "## Authentication\n\n| Parameter | Type | Description |\n| --- | --- | --- |\n| `api_key` | string | Your API key. Required. |\n| `token` | string | A session token from `/v1/sessions`. |\n\n**Authorization:** `Bearer <token>`\n\n```http\nGET /v1/me HTTP/1.1\nAuthorization: Bearer YOUR_API_TOKEN\n```",
  ],
  [
    "md api ref 2",
    '### POST /v1/tokens\n\nReturns a token object.\n\n```json\n{\n  "token": "tok_live_EXAMPLE",\n  "expires_in": 3600,\n  "token_type": "Bearer"\n}\n```',
  ],
  [
    "k8s secret ${VAR}",
    'apiVersion: v1\nkind: Secret\nmetadata:\n  name: app-secrets\ntype: Opaque\nstringData:\n  DB_PASSWORD: ${DB_PASSWORD}\n  API_TOKEN: "${API_TOKEN}"\n  SECRET_KEY: ${SECRET_KEY:-changeme}',
  ],
  [
    "k8s secretKeyRef",
    "env:\n  - name: DB_PASSWORD\n    valueFrom:\n      secretKeyRef:\n        name: app-secrets\n        key: password",
  ],
  [
    "helm",
    'password: {{ .Values.db.password | quote }}\ntoken: {{ required "token is required" .Values.token }}',
  ],
  [
    "gh actions",
    "env:\n  NPM_TOKEN: ${{ secrets.NPM_TOKEN }}\n  GITHUB_TOKEN: ${{ github.token }}",
  ],
  [
    "docker compose",
    "environment:\n  POSTGRES_PASSWORD_FILE: /run/secrets/db_password\n  SECRET_KEY: ${SECRET_KEY}",
  ],
  ["data uri png", `![logo](data:image/png;base64,${png})`],
  ["data uri img tag", `<img src="data:image/png;base64,${png}">`],
  [
    "data uri long",
    `data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL`,
  ],
  ["git sha1", `Merge commit ${sha1} into main`],
  ["git short sha", "Fixed in 9fceb02 and a1b2c3d."],
  ["sha256", `sha256: ${sha256}`],
  ["sha256 checksum file", `${sha256}  omnesis-1.4.0-linux-x64.tar.gz`],
  [
    "integrity sri",
    'integrity="sha384-oqVuAfXRKap7fdgcCY5uykM6+R9GqQ8K/uxy9rx7HNQlGYl1kPzQho1wx4JwY8wC"',
  ],
  [
    "npm lock integrity",
    '"integrity": "sha512-z4PhNX7vuL3xVChQ1m2AB9Yg5AULVxXcg/SpIdNs6c5H0NE8XYXysP+DGNKHfuwvY7kxvUdBeoGlODJ6+SfaPg=="',
  ],
  ["uuid", "request id 3f2b8c1e-9a4d-4e7b-8c2a-1d5e6f7a8b9c"],
  ["docker digest", "image: example/app@sha256:" + sha256],
  ["etag", 'ETag: "33a64df551425fcc55e4d42a148795d9f25f89d4"'],
  ["password hash", "password_hash: $2b$12$KIXQJxYQ8h9c1kYp0l1zUeQ8Y5b7m9X0aB1cD2eF3gH4iJ5kL6mN7"],
  ["sha in key=", `commit_sha=${sha1}`],
  ["hash in token-ish url", `https://example.com/assets/app.${sha1.slice(0, 20)}.js`],
  [
    "git log",
    `commit ${sha1}\nAuthor: Jordan <jordan@example.com>\nDate:   2026-03-03 10:00:00 +0000`,
  ],
  ["cdn url", "https://cdn.example.com/npm/react@18.3.1/umd/react.production.min.js"],
  [
    "prose token count",
    "The model's context window is 200k tokens; each token: roughly four characters.",
  ],
  ["prose password", "Choose a password: at least 12 characters, mixing L3tters and numb3rs."],
  [
    "changelog",
    "- token: rotate refresh tokens on use (v2.3.1)\n- password: reset links expire after 1h",
  ],
  ["Base64 config value", "encoded_key_id: dGVzdC1rZXktaWQ="],
  ["api key name only", "api_key_id: key_01HQ3Z9X7Y8K2M4N6P8R0S2T4V"],
  ["token in url path", "https://example.com/docs/tokens/rotate-v2"],
  [
    "password field html",
    '<input type="password" name="password" autocomplete="current-password">',
  ],
  ["sk- words", "Install the sk-learn2 alias: sk-plugin4you is not a key either."],
  ["Bearer in prose with digit", "the Bearer 2fa flow is described in RFC6750."],
  [
    "AKIA example literal",
    "The documented example key id looks like AKIA followed by 16 characters.",
  ],
  ["jwt docs header", 'A JWT header such as eyJhbGciOiJIUzI1NiJ9 decodes to {"alg":"HS256"}.'],
  ["long hex config", "secret_hash: " + sha256],
  ["csrf meta", '<meta name="csrf-token" content="3f2b8c1e9a4d4e7b8c2a1d5e6f7a8b9c">'],
  ["password_reset_token_ttl", "password_reset_token_ttl: 3600s"],
  ["token: placeholder", "token: YOUR_TOKEN_HERE"],
  ["token: xxxx", "token: xxxx-xxxx-xxxx"],
  ["apiKey: 'your-api-key'", "apiKey: 'your-api-key-here'"],
  [
    "k8s base64 data",
    "data:\n  username: YWRtaW4=\n  tls.crt: LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0tCk1JSUM=",
  ],
];

const CONFIG_LINES: string[] = [
  '{"issuer":"https://auth.example.com","authorization_endpoint":"https://auth.example.com/oauth2/authorize","token_endpoint":"https://auth.example.com/oauth2/token","revocation_endpoint":"https://auth.example.com/oauth2/revoke"}',
  "token_url: https://auth.example.com/oauth/token",
  "password_reset_url = https://example.com/account/reset",
  "secret_name: prod/app/db-credentials",
  "secretName: app-tls-2026",
  "tokenizer_path: models/tok-v2.json",
  "token_type_hint=refresh_token",
  "SECRET_KEY: ${SECRET_KEY:-changeme}",
  "url: ${TOKEN_URL:-https://auth.example.com/token}",
  "password_min_length: 12chars",
  "token_ttl: 3600s",
  "token_limit=8k-tokens",
  "max_tokens=4096,temperature=0.2",
  "passwordPolicy: strong-v2",
  "credentials: include",
  "credentials: same-origin",
  "fetch(url, { credentials: 'same-origin' })",
  "secretsmanager:GetSecretValue",
  "Resource: arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/app-AbCdEf",
  "secret_arn: arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/app-AbCdEf",
  "kms_key_id: arn:aws:kms:us-east-1:123456789012:key/1234abcd-12ab-34cd-56ef-1234567890ab",
  "private_key_path: ~/.ssh/id_ed25519",
  "PRIVATE_KEY_FILE=/etc/ssl/private/server.key",
  "access_key_id: AKIA-style ids are public identifiers",
  "token: 2026-01-15",
  "TOKEN_EXPIRY=2026-01-15T10:00:00Z",
  "password: P@ssw0rd!",
  "passphrase: correct-horse-battery-staple",
];

/**
 * Positives the rules deliberately miss: a value too short or of one
 * character class to tell from a word, and table cells, since a column's
 * header says nothing reliable about the shape of its cells.
 */
const KNOWN_MISSES = new Set([
  "password all lower long",
  "password 7 chars",
  "password digits only",
  "table password",
  "table api key (pipe in value?)",
]);

describe("the redaction corpus", () => {
  const caught = MUST_CATCH.filter(([label]) => !KNOWN_MISSES.has(label));

  it.each(caught)("catches %s", (_label, text) => {
    expect(redactSecrets(text)).not.toBe(text);
  });

  it("catches every case it is meant to, and reports its misses", () => {
    const missed = MUST_CATCH.filter(([, text]) => redactSecrets(text) === text).map(([l]) => l);
    expect(new Set(missed)).toEqual(KNOWN_MISSES);
  });

  it.each(DEVELOPER_PAGES)("leaves the developer page %s unchanged", (_label, text) => {
    expect(redactSecrets(text)).toBe(text);
    expect(redactShapedSecrets(text)).toBe(text);
  });

  it.each(CONFIG_LINES)("leaves %s unchanged", (text) => {
    expect(redactSecrets(text)).toBe(text);
  });

  it("is idempotent on every case", () => {
    for (const [, text] of [...MUST_CATCH, ...DEVELOPER_PAGES]) {
      const once = redactSecrets(text);
      expect(redactSecrets(once)).toBe(once);
    }
  });
});
