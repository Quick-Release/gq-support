/** A request or response body as UTF-8 text, or null once it exceeds `limit` bytes. */
// Streaming limit also bounds bodies without Content-Length.
export const readBody = async (request: Pick<Request, "body">, limit: number): Promise<string | null> => {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
};
