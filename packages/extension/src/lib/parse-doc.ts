// Format-aware text extraction for read_attachment.
//
// Goal: turn an ArrayBuffer (the raw response body of a fetched attachment)
// into a plain-text representation, without depending on local CLI tools.
//
// Supported formats:
//   - text-ish (txt, md, csv, json, xml, html) — decode as UTF-8, light
//     normalisation
//   - docx — DOCX is just a ZIP containing `word/document.xml`; we decompress
//     that one entry using the browser's built-in DecompressionStream, then
//     strip XML tags and collapse whitespace
//   - pdf — DEFERRED to v0.9.4 (see plan); for now we return a structured error
//     pointing the caller at download_file + local pdftotext.

export type SupportedFormat =
  | "txt"
  | "md"
  | "csv"
  | "json"
  | "xml"
  | "html"
  | "docx"
  | "pdf";

export function detectFormat(contentType: string, urlOrName: string): SupportedFormat | null {
  const ct = contentType.toLowerCase();
  const lower = urlOrName.toLowerCase();
  if (ct.includes("officedocument.wordprocessingml") || lower.endsWith(".docx")) return "docx";
  if (ct.includes("application/pdf") || lower.endsWith(".pdf")) return "pdf";
  if (ct.includes("application/json") || lower.endsWith(".json")) return "json";
  if (ct.includes("text/html") || lower.endsWith(".html") || lower.endsWith(".htm")) return "html";
  if (ct.includes("text/markdown") || lower.endsWith(".md") || lower.endsWith(".markdown")) return "md";
  if (ct.includes("text/csv") || lower.endsWith(".csv")) return "csv";
  if (ct.includes("application/xml") || ct.includes("text/xml") || lower.endsWith(".xml")) return "xml";
  if (ct.startsWith("text/")) return "txt";
  return null;
}

export async function parseDoc(buffer: ArrayBuffer, format: SupportedFormat): Promise<string> {
  switch (format) {
    case "txt":
    case "md":
    case "csv":
    case "json":
      return new TextDecoder("utf-8", { fatal: false }).decode(buffer);
    case "html":
    case "xml":
      return stripTags(new TextDecoder("utf-8", { fatal: false }).decode(buffer));
    case "docx":
      return await extractDocx(buffer);
    case "pdf":
      throw new Error(
        "PDF parsing is not yet implemented in chromeflow 0.9.3. Use `download_file({url})` to save the PDF locally, then run `pdftotext` (poppler-utils) or `textutil -convert txt` (macOS) on the returned path. PDF support is planned for 0.9.4 — see https://github.com/NeoDrew/chromeflow for status."
      );
  }
}

// --- docx -----------------------------------------------------------------

async function extractDocx(buffer: ArrayBuffer): Promise<string> {
  const entry = await readZipEntry(buffer, "word/document.xml");
  if (!entry) {
    throw new Error("docx: no word/document.xml inside the archive (corrupted or not a real .docx)");
  }
  const xml = new TextDecoder("utf-8", { fatal: false }).decode(entry);
  // Word-specific markup: <w:p> = paragraph, <w:br/> = line break, <w:tab/> = tab.
  // We replace those with explicit newlines BEFORE stripping all other tags so
  // paragraph structure survives.
  const withBreaks = xml
    .replace(/<w:p[^/>]*\/>/g, "\n")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<w:br[^/>]*\/?>/g, "\n")
    .replace(/<w:tab[^/>]*\/?>/g, "\t");
  return stripTags(withBreaks);
}

function stripTags(s: string): string {
  return s
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// --- minimal ZIP reader (DEFLATE-only, single-entry lookup) ---------------

// Reads a specific named entry from a ZIP archive. Returns the decompressed
// bytes, or null if the entry isn't there. Supports STORE (no compression)
// and DEFLATE (the only two methods docx actually uses). Decompression goes
// through the browser's built-in DecompressionStream — no dependencies.

async function readZipEntry(buffer: ArrayBuffer, entryName: string): Promise<Uint8Array | null> {
  const data = new Uint8Array(buffer);
  const view = new DataView(buffer);

  // Find the End-of-Central-Directory record (EOCD) by scanning backwards
  // from the end. EOCD signature is 0x06054b50. It's at most 22 + 65535 bytes
  // from the end (the trailing comment field). For docx there's no comment, so
  // a short scan suffices.
  let eocdOffset = -1;
  const scanStart = Math.max(0, data.length - (22 + 0xffff));
  for (let i = data.length - 22; i >= scanStart; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) return null;

  const cdEntries = view.getUint16(eocdOffset + 10, true);
  const cdOffset = view.getUint32(eocdOffset + 16, true);

  // Walk the central directory to find the target entry.
  let cdPos = cdOffset;
  for (let i = 0; i < cdEntries; i++) {
    const sig = view.getUint32(cdPos, true);
    if (sig !== 0x02014b50) break; // not a CD entry — malformed archive
    const compMethod = view.getUint16(cdPos + 10, true);
    const compSize = view.getUint32(cdPos + 20, true);
    const nameLen = view.getUint16(cdPos + 28, true);
    const extraLen = view.getUint16(cdPos + 30, true);
    const commentLen = view.getUint16(cdPos + 32, true);
    const lfhOffset = view.getUint32(cdPos + 42, true);
    const name = new TextDecoder("utf-8").decode(data.subarray(cdPos + 46, cdPos + 46 + nameLen));

    if (name === entryName) {
      // Found it. Now read the Local File Header to get the data offset.
      const lfhNameLen = view.getUint16(lfhOffset + 26, true);
      const lfhExtraLen = view.getUint16(lfhOffset + 28, true);
      const dataStart = lfhOffset + 30 + lfhNameLen + lfhExtraLen;
      const compressed = data.subarray(dataStart, dataStart + compSize);

      if (compMethod === 0) {
        // Stored uncompressed.
        return compressed;
      } else if (compMethod === 8) {
        // DEFLATE — use the browser's built-in DecompressionStream.
        const stream = new Response(compressed).body!.pipeThrough(new DecompressionStream("deflate-raw"));
        const buf = await new Response(stream).arrayBuffer();
        return new Uint8Array(buf);
      } else {
        throw new Error(`docx: unsupported compression method ${compMethod}`);
      }
    }

    cdPos += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}
