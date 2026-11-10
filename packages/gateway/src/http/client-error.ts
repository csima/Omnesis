// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { ServerType } from "@hono/node-server";
import type { Duplex } from "node:stream";

/**
 * Answer a request whose body was cut off by the client closing its side of
 * the connection with 408 instead of Node's default 400.
 *
 * Node's HTTP parser, not the app, sees that case first: the connection ends
 * before `Content-Length` bytes arrived (`HPE_INVALID_EOF_STATE`), and with
 * no `clientError` listener Node writes a bare `400 Bad Request`. A client
 * cannot tell that from a verdict on its payload, and the phone gives up on a
 * batch that keeps drawing one. The body was never wrong, only incomplete, so
 * the answer is the one the request-body check in `validateJson` gives for
 * the same cause. Every other parser error keeps Node's own response.
 */
export function attachClientErrorResponses(server: ServerType): void {
  server.on("clientError", (err: NodeJS.ErrnoException, socket: Duplex) => {
    // As Node does: answer only while nothing of a response has gone out.
    const response = (socket as Duplex & { _httpMessage?: { headersSent?: boolean } })._httpMessage;
    if (socket.writable && !response?.headersSent) socket.write(responseFor(err.code));
    socket.destroy(err);
  });
}

const INCOMPLETE_BODY = JSON.stringify({
  error: "Request body ended before it was complete",
  code: "REQUEST_BODY_INCOMPLETE",
});

function responseFor(code: string | undefined): string {
  switch (code) {
    case "HPE_INVALID_EOF_STATE":
      return (
        "HTTP/1.1 408 Request Timeout\r\nConnection: close\r\nContent-Type: application/json\r\n" +
        `Content-Length: ${Buffer.byteLength(INCOMPLETE_BODY)}\r\n\r\n${INCOMPLETE_BODY}`
      );
    // Node's defaults (lib/_http_server.js), which a listener replaces.
    case "HPE_HEADER_OVERFLOW":
      return "HTTP/1.1 431 Request Header Fields Too Large\r\nConnection: close\r\n\r\n";
    case "HPE_CHUNK_EXTENSIONS_OVERFLOW":
      return "HTTP/1.1 413 Payload Too Large\r\nConnection: close\r\n\r\n";
    case "ERR_HTTP_REQUEST_TIMEOUT":
      return "HTTP/1.1 408 Request Timeout\r\nConnection: close\r\n\r\n";
    default:
      return "HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n";
  }
}
