export async function parseCsv(
  stream: ReadableStream<Uint8Array>,
  onRow: (row: string[]) => void | Promise<void>,
) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let cell = "",
    row: string[] = [],
    quoted = false,
    pendingQuote = false,
    skipLf = false;
  const consume = async (text: string, final = false) => {
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      if (pendingQuote) {
        pendingQuote = false;
        if (char === '"') {
          cell += '"';
          continue;
        }
        quoted = false;
      }
      if (skipLf) {
        skipLf = false;
        if (char === "\n") continue;
      }
      if (char === '"') {
        if (quoted) {
          if (index + 1 < text.length) {
            if (text[index + 1] === '"') {
              cell += '"';
              index += 1;
            } else quoted = false;
          } else if (final) quoted = false;
          else pendingQuote = true;
        } else if (!cell) quoted = true;
        else cell += char;
      } else if (char === "," && !quoted) {
        row.push(cell.trim());
        cell = "";
      } else if ((char === "\n" || char === "\r") && !quoted) {
        row.push(cell.trim());
        cell = "";
        if (row.some((value) => value !== "")) { const pending = onRow(row); if (pending) await pending; }
        row = [];
        if (char === "\r") skipLf = true;
      } else cell += char;
    }
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    await consume(decoder.decode(value, { stream: true }));
  }
  await consume(decoder.decode(), true);
  if (cell || row.length) {
    row.push(cell.trim());
    if (row.some((value) => value !== "")) { const pending = onRow(row); if (pending) await pending; }
  }
}
