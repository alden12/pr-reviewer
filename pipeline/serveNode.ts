/**
 * `host.ts`'s web-standard handlers on `node:http` (DIST-2): the one adapter, shared by the dev server's middleware
 * and the `serve` command, so the two can't answer differently. A handler that answers `undefined` passes the request
 * on (`next`), which is how vite keeps serving the app around it.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Handler } from "./host.ts";

/**
 * The node stream as a web one that reads nothing until it is pulled: `Readable.toWeb` starts reading as soon as it is
 * made, which would drain the body of a request the handler passes on. Node's async iterator is a generator, so it too
 * starts only on the first pull, and a high-water mark of 0 keeps the web stream from pulling ahead of its reader.
 */
const lazyBody = (request: IncomingMessage): ReadableStream<Uint8Array> => {
  let chunks: AsyncIterator<Buffer> | undefined;
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        chunks ??= request[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
        const { done, value } = await chunks.next();
        if (done) controller.close();
        else controller.enqueue(new Uint8Array(value));
      },
      async cancel() {
        await chunks?.return?.();
      },
    },
    { highWaterMark: 0 },
  );
};

/**
 * The node request as a fetch `Request`, at its full URL so a handler reads the path and query as usual. The body is
 * the node stream itself, read only if the handler reads it, so a request it passes on reaches `next` with its body
 * still there (a host's own POST routes behind these).
 */
export function toRequest(request: IncomingMessage): Request {
  const headers = new Headers(
    Object.entries(request.headers).flatMap(([name, value]) =>
      value === undefined ? [] : [[name, Array.isArray(value) ? value.join(", ") : value] as [string, string]],
    ),
  );
  const method = request.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";
  return new Request(`http://${request.headers.host ?? "localhost"}${request.url ?? "/"}`, {
    method,
    headers,
    // `duplex` is required for a streamed body and missing from the DOM types.
    ...(hasBody ? { body: lazyBody(request), duplex: "half" } : {}),
  } as RequestInit);
}

/** A fetch `Response` written out to node's response. */
export async function writeResponse(answer: Response, response: ServerResponse): Promise<void> {
  response.statusCode = answer.status;
  answer.headers.forEach((value, name) => response.setHeader(name, value));
  response.end(answer.body ? Buffer.from(await answer.arrayBuffer()) : undefined);
}

/** `handler` as connect-style middleware: answered, or passed on to `next`. */
export const nodeHandler =
  (handler: Handler) =>
  (request: IncomingMessage, response: ServerResponse, next: () => void): void => {
    void Promise.resolve()
      .then(() => handler(toRequest(request)))
      .then(
        (answer) => (answer ? writeResponse(answer, response) : next()),
        (error: unknown) => {
          response.statusCode = 500;
          response.end(error instanceof Error ? error.message : String(error));
        },
      );
  };
