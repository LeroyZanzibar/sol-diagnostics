# Runtime notes

The Docker edition keeps the existing API routes and Drizzle D1 query layer. `LocalDatabase` implements the application's D1 statement contract with Node 24's built-in SQLite driver, WAL journaling, atomic batches, positional rows, and a checksum-protected migration ledger. `LocalBucket` implements the used R2 object contract with streamed files plus SQLite metadata, opaque filenames, fsync before publishing metadata, and atomic version changes. No local worker emulator or Cloudflare service is used.

`server.mjs` initializes storage before loading the built Vinext request handler. `db/binding.ts` obtains those bindings through a process-local symbol. This avoids bundling native storage into browser assets. The server applies authentication before static files, API routes, and HTML, replaces incoming identity headers with the configured local actor, rejects cross-origin mutations, and exposes only a minimal public health endpoint.

The original fixed-length stream contract for multipart CSV finalization is provided by a checked TransformStream. Existing analysis checkpoints, resumable stages, interval loss allocation, stored analyses, review evidence, and conflict checks remain in the application code. Superseded-file cleanup runs after uploads and periodically once the application has initialized its bindings. The old hosted placeholder-site deletion hook is not invoked.

The front end opens an empty installation in Add site mode rather than displaying a fictitious portfolio. Runtime metadata uses SOL_PUBLIC_URL when configured. This copy has no hosted Site identity, so it cannot accidentally publish over the original site.

SQLite and object files must be backed up together with the application stopped. The data volume is single-instance; running several server processes against it is unsupported. Analysis advances using the existing browser request/poll workflow, so closing the browser can pause an unfinished analysis until a later request resumes it.
