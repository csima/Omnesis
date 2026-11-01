// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { REDACTED_SECRET, redactSecrets, redactShapedSecrets } from "./redact-secrets.js";

/**
 * Every credential below is invented and assembled at run time from a prefix
 * and filler, so no string in this file has the shape a secret scanner looks
 * for.
 */
const join = (...parts: string[]): string => parts.join("");
const FILLER = "Q7rT2mX9pL4vN8kB3cZ6wY1hJ5dF0sGa";

const SHAPED: Array<[string, string]> = [
  ["a bearer credential", join("Bearer ", FILLER.slice(0, 20), "==")],
  ["a Slack bot token", join("xo", "xb-", "1234567890-", FILLER.slice(0, 12))],
  ["a Slack app token", join("xa", "pp-1-", FILLER.slice(0, 14))],
  ["a Slack webhook", join("hooks.slack", ".com/services/", "T000/B000/", FILLER.slice(0, 16))],
  ["an sk- key", join("s", "k-", FILLER)],
  ["an sk-proj- key", join("s", "k-proj-", FILLER)],
  ["an sk-ant- key", join("s", "k-ant-api03-", FILLER)],
  ["a JWT", join("ey", "J", FILLER.slice(0, 12), ".ey", "J", FILLER.slice(4, 18), ".", FILLER)],
  ["a GitHub classic token", join("gh", "p_", FILLER, "AbCd")],
  ["a GitHub OAuth token", join("gh", "o_", FILLER, "AbCd")],
  ["a GitHub fine-grained token", join("github", "_pat_", FILLER)],
  ["an AWS access key id", join("AK", "IA", "EXAMPLE0FICTION1")],
  ["an AWS temporary key id", join("AS", "IA", "EXAMPLE0FICTION1")],
  ["an agent host token", join("ah", "k_", FILLER.slice(0, 20))],
  ["an agent host browser token", join("bx", "t_", FILLER.slice(0, 20))],
  ["a Stripe secret key", join("s", "k_", "live_", FILLER.slice(0, 16))],
  ["a Stripe restricted key", join("r", "k_", "test_", FILLER.slice(0, 16))],
  ["a Google API key", join("AI", "za", FILLER, "xyz")],
  ["a GitLab token", join("gl", "pat-", FILLER.slice(0, 22))],
  ["an Omnesis token", join("om", "n_", "oat_", FILLER)],
  ["an npm token", join("np", "m_", FILLER, "Ab12")],
  ["a PyPI token", join("py", "pi-", "AgEI", FILLER, FILLER)],
  ["a SendGrid key", join("S", "G.", FILLER.slice(0, 22), ".", FILLER, "Abcdefghijk")],
  ["a Discord bot token", join("M", FILLER.slice(0, 23), ".", "Gh1jKl", ".", FILLER)],
  ["a Telegram bot token", join("123456789", ":A", "A", FILLER, "xyz")],
  ["an hf_ token", join("h", "f_", FILLER)],
  ["a Google OAuth access token", join("ya", "29.", FILLER)],
  ["a Google OAuth client secret", join("GOC", "SPX-", FILLER.slice(0, 28))],
  ["a Stripe webhook secret", join("wh", "sec_", FILLER)],
  ["an Azure AD client secret", join("aB3", "8Q", "~", FILLER.slice(0, 34))],
  ["a Shopify access token", join("shp", "at_", "0123456789abcdef0123456789abcdef")],
  ["a Shopify shared secret", join("shp", "ss_", "fedcba9876543210fedcba9876543210")],
  ["a DigitalOcean token", join("dop", "_v1_", "0123456789abcdef".repeat(4))],
  ["a Vault token", join("hv", "s.", FILLER)],
  ["a Doppler token", join("dp", ".st.", "dev.", FILLER, "Ab12Cd34")],
  ["a Linear key", join("lin", "_api_", FILLER, "Ab12Cd34")],
  ["a Notion token", join("nt", "n_", FILLER, "Ab12Cd34")],
  [
    "an age secret key",
    join("AGE-", "SECRET-KEY-1", "QWERTYUIOPASDFGHJKLZXCVBNM0123456789QWERTYUIOPASDFGHJKLZXC"),
  ],
];

describe("redactSecrets", () => {
  it.each(SHAPED)("redacts %s in running text", (_label, secret) => {
    const text = `Before the value ${secret} and after it.`;
    const redacted = redactSecrets(text);
    expect(redacted).toBe(`Before the value ${REDACTED_SECRET} and after it.`);
    expect(redacted).not.toContain(secret);
  });

  it.each(SHAPED)("redacts %s with its characters Markdown-escaped", (_label, secret) => {
    const escaped = secret.replace(/[_*]/g, (char) => `\\${char}`);
    const redacted = redactSecrets(`Before ${escaped} after.`);
    expect(redacted).toBe(`Before ${REDACTED_SECRET} after.`);
  });

  it("redacts Markdown-escaped names in assignments and an escaped PEM armour line", () => {
    expect(redactSecrets("api\\_key = abc123def456")).toBe(`api\\_key = ${REDACTED_SECRET}`);
    const secret = `${FILLER}${FILLER.slice(0, 8)}`;
    expect(redactSecrets(`aws\\_secret\\_access\\_key: ${secret}`)).toBe(REDACTED_SECRET);
    const pem = join("\\-----BEGIN ", "PRIVATE KEY-----\n", FILLER, "\n-----END PRIVATE KEY-----");
    expect(redactSecrets(pem)).toBe(REDACTED_SECRET);
  });

  it.each([
    ["DB_PASSWORD=correct-horse-battery", "DB_PASSWORD=[redacted]"],
    ["GITHUB_ACCESS_TOKEN=abc123def456", "GITHUB_ACCESS_TOKEN=[redacted]"],
    ["export STRIPE\\_SECRET\\_KEY=abc123def456", "export STRIPE\\_SECRET\\_KEY=[redacted]"],
    ["secret: plain-value", "secret: [redacted]"],
    ["token = abc123def456", "token = [redacted]"],
    ["private_key: abc123def456", "private_key: [redacted]"],
    ["pwd=hunter-two", "pwd=[redacted]"],
  ])("redacts the .env-style assignment %s", (input, expected) => {
    expect(redactSecrets(input)).toBe(expected);
  });

  it("redacts quoted JSON and YAML values, spaces and all", () => {
    expect(redactSecrets('{"password": "hunter two", "user": "maya"}')).toBe(
      '{"password": [redacted], "user": "maya"}',
    );
    expect(redactSecrets("{'api_key':'abc123def456'}")).toBe("{'api_key':[redacted]}");
    expect(redactSecrets('client_secret: "s3cr3t value"')).toBe("client_secret: [redacted]");
  });

  it("takes an authorization scheme with its credential, in any case", () => {
    const basic = join("dXNl", "cjpw", "YXNz");
    expect(redactSecrets(`Authorization: Basic ${basic}`)).toBe("Authorization: [redacted]");
    expect(redactSecrets(`authorization: basic ${basic}`)).toBe("authorization: [redacted]");
    expect(redactSecrets(`-H "Authorization: Token ${basic}"`)).toBe(
      '-H "Authorization: [redacted]"',
    );
    expect(redactSecrets(`Authorization: bearer ${basic}`)).toBe("Authorization: [redacted]");
  });

  it("redacts the user and password in a URL and in curl -u", () => {
    expect(redactSecrets(join("redis://:", "Xk9mQ2vLp7", "@cache.example.com:6379/0"))).toBe(
      "redis://[redacted]@cache.example.com:6379/0",
    );
    expect(redactSecrets(join("https://jordan:", "Xk9@mQ2vLp", "@db.example.com/"))).toBe(
      "https://[redacted]@db.example.com/",
    );
    expect(redactSecrets("postgres://app:hunter-two@db.example.com:5432/main")).toBe(
      "postgres://[redacted]@db.example.com:5432/main",
    );
    expect(redactSecrets("see https://maya:s3cret@files.example.org/x for the file")).toBe(
      "see https://[redacted]@files.example.org/x for the file",
    );
    expect(redactSecrets("curl -u maya:hunter-two https://api.example.com")).toBe(
      "curl -u [redacted] https://api.example.com",
    );
    expect(redactSecrets("curl --user 'maya:hunter two' https://api.example.com")).toBe(
      "curl --user [redacted] https://api.example.com",
    );
    expect(redactSecrets("mailto:maya@example.com and https://example.com/a@b")).toBe(
      "mailto:maya@example.com and https://example.com/a@b",
    );
  });

  it("redacts the key in a connection string and keeps the rest", () => {
    const key = join(FILLER, FILLER, "==");
    expect(
      redactSecrets(
        `DefaultEndpointsProtocol=https;AccountName=northstar;AccountKey=${key};EndpointSuffix=core.windows.net`,
      ),
    ).toBe(
      "DefaultEndpointsProtocol=https;AccountName=northstar;AccountKey=[redacted];EndpointSuffix=core.windows.net",
    );
  });

  it("redacts a PGP private key block", () => {
    const block = join(
      "-----BEGIN PGP ",
      "PRIVATE KEY BLOCK-----\n",
      "Version: Fictional 1.0\n\n",
      FILLER,
      "\n",
      FILLER,
      "\n-----END PGP PRIVATE KEY BLOCK-----",
    );
    expect(redactSecrets(`Key:\n${block}\nDone.`)).toBe(`Key:\n${REDACTED_SECRET}\nDone.`);
  });

  it("ends an unterminated private key at its body, so the rest of the page stays", () => {
    const pem = join("-----BEGIN ", "PRIVATE KEY-----\n", FILLER, "\n", FILLER);
    expect(redactSecrets(`${pem}\n\nThe rest of the fictional runbook stays readable.`)).toBe(
      `${REDACTED_SECRET}\n\nThe rest of the fictional runbook stays readable.`,
    );
  });

  it("finds a token split by zero-width characters or soft hyphens", () => {
    const token = join("gh", "p_", FILLER, "AbCd");
    const hidden = `${token.slice(0, 10)}\u200b${token.slice(10, 20)}\u00ad${token.slice(20)}`;
    expect(redactSecrets(`Token ${hidden} here`)).toBe(`Token ${REDACTED_SECRET} here`);
  });

  it("finds a token split across adjacent code spans", () => {
    const token = join("gh", "p_", FILLER, "AbCd");
    expect(redactSecrets(`Use \`${token.slice(0, 12)}\`\`${token.slice(12)}\` here`)).toBe(
      `Use \`${REDACTED_SECRET}\` here`,
    );
  });

  it("redacts the whole of a bearer JWT, underscores included", () => {
    const jwt = join("ey", "J", "hbGciOi_JIUzI1", ".ey", "J", "zdWIi_OiJmaWN0", ".sig_nat-ure");
    expect(redactSecrets(`Authorization: Bearer ${jwt}`)).toBe(`Authorization: ${REDACTED_SECRET}`);
  });

  it("redacts a PEM private key from armour to armour, across lines", () => {
    const pem = join(
      "-----BEGIN ",
      "RSA PRIVATE KEY-----\n",
      FILLER,
      "\n",
      FILLER,
      "\n-----END RSA PRIVATE KEY-----",
    );
    expect(redactSecrets(`## Key\n\n${pem}\n\nNext paragraph.`)).toBe(
      `## Key\n\n${REDACTED_SECRET}\n\nNext paragraph.`,
    );
  });

  it("redacts an unterminated private key to the end of the text", () => {
    const pem = join("-----BEGIN ", "PRIVATE KEY-----\n", FILLER, "\n", FILLER);
    expect(redactSecrets(`Key:\n${pem}`)).toBe(`Key:\n${REDACTED_SECRET}`);
  });

  it("redacts an AWS secret access key after its name", () => {
    const secret = `${FILLER}${FILLER.slice(0, 8)}`;
    expect(secret).toHaveLength(40);
    expect(redactSecrets(`aws_secret_access_key = ${secret}`)).toBe(REDACTED_SECRET);
    expect(redactSecrets(`AWS_SECRET_ACCESS_KEY="${secret}"`)).toBe(REDACTED_SECRET);
  });

  it("keeps a credential's name and redacts the value assigned to it", () => {
    expect(redactSecrets("password: correct-horse-battery")).toBe(`password: ${REDACTED_SECRET}`);
    expect(redactSecrets("API_KEY=abc123def456")).toBe(`API_KEY=${REDACTED_SECRET}`);
    expect(redactSecrets("client_secret = s3cr3t-value")).toBe(
      `client_secret = ${REDACTED_SECRET}`,
    );
    expect(redactSecrets("**Password:** correct-horse")).toBe(`**Password:** ${REDACTED_SECRET}`);
    expect(redactSecrets(`Authorization: ${join("Bearer ", FILLER)}`)).toBe(
      `Authorization: ${REDACTED_SECRET}`,
    );
  });

  it("never reaches past the end of the line for an assigned value", () => {
    expect(redactSecrets("Password:\n\nChoose one you have not used before.")).toBe(
      "Password:\n\nChoose one you have not used before.",
    );
  });

  it("leaves ordinary prose, Markdown and look-alike words alone", () => {
    const prose = [
      "# Bearer authentication",
      "",
      "Bearer tokens are described in RFC 6750; the scheme name is case-insensitive.",
      "The skeleton-key approach and an sk-short label are both fine.",
      "A ghp_ prefix alone, AKIA alone and eyJ alone are not credentials.",
      "Reset your password from the account page.",
    ].join("\n");
    expect(redactSecrets(prose)).toBe(prose);
  });

  it("is idempotent, so a page the extension redacted keeps its hash on the gateway", () => {
    const text =
      SHAPED.map(([, secret]) => `x ${secret} y`).join("\n") +
      "\npassword: hunter-two\nAuthorization: Basic dXNlcjpwYXNz\npostgres://a:b@db.example.com\n" +
      "| Token |\n| --- |\n| abc |";
    const once = redactSecrets(text);
    expect(redactSecrets(once)).toBe(once);
    for (const [, secret] of SHAPED) expect(once).not.toContain(secret);
  });

  it("returns empty text unchanged", () => {
    expect(redactSecrets("")).toBe("");
  });

  it.each([
    ["accessToken: Q7rT2mX9pL4v", "accessToken: [redacted]"],
    ["refreshToken = Q7rT2mX9pL4v", "refreshToken = [redacted]"],
    ["clientSecret: Q7rT2mX9pL4v", "clientSecret: [redacted]"],
    ["privateKey: Q7rT2mX9pL4v", "privateKey: [redacted]"],
    ["DB_PASS=hunter-two-x", "DB_PASS=[redacted]"],
    ["API_TOKEN=Q7rT2mX9pL4v;", "API_TOKEN=[redacted];"],
    ["STRIPE_SECRET_KEY=Q7rT2mX9pL4v", "STRIPE_SECRET_KEY=[redacted]"],
    ["password=!Xk9mQ2vLp", "password=[redacted]"],
    ["spring.datasource.password=Xk9#mQ2vLp", "spring.datasource.password=[redacted]"],
    ["define('DB_PASSWORD', 'Xk9#mQ2vLp');", "define('DB_PASSWORD', [redacted]);"],
    ["<password>Xk9#mQ2vLp</password>", "<password>[redacted]</password>"],
  ])("redacts the credential name %s", (input, expected) => {
    expect(redactSecrets(input)).toBe(expected);
  });

  it("redacts a private key quoted or indented in Markdown", () => {
    const quoted = join(
      "> -----BEGIN ",
      "PRIVATE KEY-----\n> ",
      FILLER,
      "\n> ",
      FILLER,
      "\n> -----END PRIVATE KEY-----",
    );
    expect(redactSecrets(`Quoted:\n\n${quoted}\n\nAfter.`)).toBe(
      `Quoted:\n\n> ${REDACTED_SECRET}\n\nAfter.`,
    );
    const indented = join("    -----BEGIN ", "PRIVATE KEY-----\n    ", FILLER, "\n    ", FILLER);
    expect(redactSecrets(`${indented}\n\nNext paragraph with a longword.`)).toBe(
      `    ${REDACTED_SECRET}\n\nNext paragraph with a longword.`,
    );
  });

  it("finds a token split by invisible separators", () => {
    const token = join("gh", "p_", FILLER, "AbCd");
    const hidden = `${token.slice(0, 10)}⁣${token.slice(10, 20)}⁢${token.slice(20)}`;
    expect(redactSecrets(`Token ${hidden} here`)).toBe(`Token ${REDACTED_SECRET} here`);
  });

  it("applies only the shaped rules through redactShapedSecrets", () => {
    const token = join("gh", "p_", FILLER, "AbCd");
    expect(redactShapedSecrets(`password: hunter-two-x and ${token}`)).toBe(
      `password: hunter-two-x and ${REDACTED_SECRET}`,
    );
  });
});

/**
 * Text that names credentials without holding one: code, types, docs and
 * tables. Every line must come back exactly as it went in.
 */
const NOT_SECRETS = [
  "interface Login { password: string; remember: boolean }",
  "type Session = { token: string | null; expires: number };",
  "if (token === null) return;",
  "if (password == confirm) submit();",
  "while (token !== undefined) next();",
  "const token = getToken();",
  "password := readPassword()",
  "Password: must be at least twelve characters long.",
  "Authorization: required for every request.",
  "Authorization: Bearer token",
  "token: ${{ secrets.DEPLOY_TOKEN }}",
  "password: $DB_PASSWORD",
  "password: <your-password>",
  "api_key: {{ .Values.apiKey }}",
  'password: "********"',
  "secret_key = settings.SECRET_KEY",
  "SECRET_KEY = os.environ['SECRET_KEY']",
  "token = os.getenv('API_TOKEN')",
  "password: Optional[str] = None",
  "tokens: Array<string>",
  "api_key: str",
  "token_type: bearer",
  "max_tokens: 4096",
  "tokenizer: sentencepiece",
  "password_hint: The name of your first pet",
  "PASSWORD: DB_PASSWORD",
  "Use scikit-learn, written sk-learn-is-a-python-ml-library-name in some notes.",
  "Run `npm` ``install`` then start the server.",
  "Call `token` and `secret` in that order.",
  "| Token | Price | Change |\n| --- | --- | --- |\n| Northcoin | 1.2345 | +2.5% |\n| Ridgecoin | 0.0042 | -1.1% |",
  "| Field | Password |\n| --- | --- |\n| Strength | required |",
  "## Passwords\n\nA password manager keeps every password: unique, long and random.",
  "The secret: practice every day.",
];

describe("redactSecrets leaves text that only talks about credentials alone", () => {
  it.each(NOT_SECRETS)("%s", (text) => {
    expect(redactSecrets(text)).toBe(text);
  });
});

/**
 * Inputs built to make a backtracking pattern scan its run once per start:
 * repeated pattern tokens, long runs after an opening tick or a table pipe,
 * and a minified bundle on one line.
 */
const N = 200_000;
const tick = "`";
const PATHOLOGICAL: Array<[string, (size: number) => string]> = [
  ...(
    [
      ["eyJ- runs", "eyJ-"],
      ["a. runs", "a."],
      ["xoxb- runs", "xoxb-"],
      ["M runs", "MAAAAAAAAAAAAAAAAAAAAAAAAA."],
      ["sk- runs", "sk-"],
      ["digit-colon runs", "1234567890:AA"],
      ["armour lines", join("-----BEGIN ", "PRIVATE KEY-----")],
      ["armour with chunks", join("-----BEGIN ", "PRIVATE KEY-----\nQ7rT2mX9pL4vN8kB ")],
      ["armour with quoted breaks", join("-----BEGIN ", "PRIVATE KEY-----", "\n>".repeat(50))],
      ["Bearer runs", "Bearer a"],
      ["assignments", "password=a"],
      ["call-like values", "token=("],
      ["quoted assignments", '"token":"'],
      ["url schemes", "a+b.c-d:"],
      ["userinfo", "https://a:b"],
      ["curl users", " --user 'a:"],
      ["tilde runs", "abc1Q~"],
      ["code spans", "`a``"],
      ["single ticks", "`aaaaaaaaaaaaaaaaaaaa"],
      ["table rows", "| Password |\n| --- |\n| x |\n"],
      ["dotted runs", "hvs.dp.st.ya29.SG."],
    ] as const
  ).map(
    ([label, unit]) =>
      [label, (size: number) => unit.repeat(Math.ceil(size / unit.length)).slice(0, size)] as [
        string,
        (size: number) => string,
      ],
  ),
  ["one tick then a long run", (size) => `${tick}${tick} x${tick}${"a".repeat(size)}`],
  ["table separator with leading spaces", (size) => `|a\n${" ".repeat(size)}x`],
  ["table separator with trailing spaces", (size) => `|a\n| --- ${" ".repeat(size)}x`],
  [
    "minified bundle",
    (size) => {
      const unit = "function a(e,t){return e.map(function(n){return n*t+1})};var b=a([1,2,3],4);";
      let body = "";
      for (let i = 0; body.length < size; i++)
        body += i % 600 === 599 ? "var s=`row ${b[0]}`;" : unit;
      return `\`\`\`js\n${body.slice(0, size)}\n\`\`\``;
    },
  ],
];

/**
 * Below this, a run says nothing about its growth: a quadratic pattern takes
 * seconds on these sizes, and a few milliseconds are scheduling noise.
 */
const FLOOR_MS = 25;

/** The fastest of three runs, which keeps a busy host's pauses out of the ratio. */
function fastest(text: string): number {
  let best = Infinity;
  for (let i = 0; i < 3; i++) {
    const started = performance.now();
    redactSecrets(text);
    best = Math.min(best, performance.now() - started);
  }
  return best;
}

/**
 * Time grows with the text, not faster: four times the input may take at
 * most six times as long. An absolute budget flakes on a loaded host; a ratio
 * of the same input at two sizes does not, and a quadratic pattern shows as a
 * ratio near sixteen. The last term absorbs timer granularity and scheduling
 * noise on inputs that finish in a few milliseconds.
 */
function expectLinear(build: (size: number) => string): void {
  const small = fastest(build(N / 4));
  const large = fastest(build(N));
  expect(large).toBeLessThanOrEqual(Math.max(FLOOR_MS, 6 * small + 5));
}

describe("redactSecrets runs in linear time", () => {
  it.each(PATHOLOGICAL)("%s", (_label, build) => {
    expectLinear(build);
  });

  /** Inputs built at random from the tokens the patterns are made of. */
  const TOKENS = [
    "eyJ",
    ".",
    "-",
    "_",
    "\\",
    "`",
    "``",
    "|",
    " ",
    "\n",
    "\n> ",
    "=",
    ":",
    "://",
    "@",
    "/",
    "a",
    "A",
    "0",
    "Bearer ",
    "password",
    "token",
    "secret",
    "api_key",
    "DB_PASSWORD",
    "Authorization: ",
    "Basic ",
    "xoxb-",
    "sk-",
    "ghp_",
    "AKIA",
    "hvs.",
    "SG.",
    "dp.st.",
    "-u ",
    "--user ",
    "AccountKey=",
    "aws_secret_access_key",
    "-----BEGIN ",
    "PRIVATE KEY-----",
    "-----END ",
    "Q~",
    "M",
    "<password>",
    "</password>",
    "define('",
    "', '",
    "${",
    "{{",
    "'",
    '"',
    "(",
    ")",
  ];

  it("stays linear on 200 random token mixes", () => {
    let seed = 0x5eed;
    const random = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let round = 0; round < 200; round++) {
      const unit = Array.from(
        { length: 4 + Math.floor(random() * 12) },
        () => TOKENS[Math.floor(random() * TOKENS.length)]!,
      ).join("");
      const build = (size: number): string =>
        unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
      const small = fastest(build(N / 8));
      const large = fastest(build(N / 2));
      expect(large, JSON.stringify(unit)).toBeLessThanOrEqual(Math.max(FLOOR_MS, 6 * small + 5));
    }
  }, 120_000);
});

describe("windows over long lines", () => {
  it("redacts a token that straddles a window boundary, whole and once", () => {
    const token = join("gh", "p_", FILLER, "AbCd");
    for (const at of [4096 - 512 - 10, 4096 - 20, 4096 - 512 + 5, 7168 - 3]) {
      const line = `${"a ".repeat(Math.floor(at / 2))}${token} ${"b ".repeat(3000)}`;
      const out = redactSecrets(line);
      expect(out).not.toContain(token.slice(4, 20));
      expect(out.split(REDACTED_SECRET)).toHaveLength(2);
      expect(redactSecrets(out)).toBe(out);
    }
  });

  it("redacts every token on a minified line of many windows", () => {
    const token = join("gh", "p_", FILLER, "AbCd");
    const line = Array.from({ length: 40 }, (_, i) => `var t${i}="${token}";`).join(
      "x".repeat(400),
    );
    const out = redactSecrets(line);
    expect(out).not.toContain(token.slice(4));
    expect(out.split(REDACTED_SECRET)).toHaveLength(41);
  });
});
