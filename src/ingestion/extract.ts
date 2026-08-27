import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { MetisError } from "../shared/errors.js";
import type { SourceTypeDescriptor } from "../contracts/source-types.js";
import { messageOf } from "../shared/util.js";
import {
  MAX_VISION_IMAGE_BYTES,
  type VisionTranscriber,
} from "./vision.js";

const execFileAsync = promisify(execFile);

/** Byte ceiling for text and PDF sources; images use MAX_VISION_IMAGE_BYTES. */
const MAX_SOURCE_BYTES = 32 * 1024 * 1024;

export function maxBytesFor(descriptor: SourceTypeDescriptor): number {
  return descriptor.method === "vision" ? MAX_VISION_IMAGE_BYTES : MAX_SOURCE_BYTES;
}

export interface ExtractedText {
  text: string;
  model?: string;
}

/**
 * Derive searchable text for one source.
 *
 * Every branch is a pure function of the stored bytes except `vision`, whose
 * transcript is persisted so line citations stay stable across reads.
 */
export async function extractSourceText(input: {
  descriptor: SourceTypeDescriptor;
  bytes: Buffer;
  absolutePath: string;
  title: string;
  transcriber?: VisionTranscriber;
}): Promise<ExtractedText> {
  switch (input.descriptor.method) {
    case "verbatim":
      return { text: normalizeText(decodeUtf8(input.bytes, input.title)) };
    case "markdown":
      return { text: extractMarkdownText(decodeUtf8(input.bytes, input.title)) };
    case "latex":
      return { text: extractLatexText(decodeUtf8(input.bytes, input.title)) };
    case "pdftotext":
      return { text: normalizeText(await extractPdfText(input.absolutePath)) };
    case "vision": {
      const transcriber = input.transcriber;
      if (!transcriber) {
        throw new MetisError(
          "EXTRACT_VISION_UNAVAILABLE",
          "Image ingestion is disabled for this Metis instance because no vision transcriber is configured.",
        );
      }
      const transcript = await transcriber.transcribe({
        bytes: input.bytes,
        mediaType: input.descriptor.mediaType ?? "image/png",
        title: input.title,
      });
      return { text: normalizeText(transcript), model: transcriber.model };
    }
  }
}

/**
 * Decode UTF-8 strictly: a byte sequence that does not round-trip is binary or
 * another encoding, and silently indexing replacement characters would store
 * unusable evidence.
 */
function decodeUtf8(bytes: Buffer, title: string): string {
  const payload = hasUtf8Bom(bytes) ? bytes.subarray(3) : bytes;
  const decoded = payload.toString("utf8");
  if (!Buffer.from(decoded, "utf8").equals(payload)) {
    throw new MetisError(
      "EXTRACT_NOT_UTF8",
      `Source '${title}' is not valid UTF-8 text. Convert it to UTF-8, or ingest it as a PDF or image instead.`,
    );
  }
  if (decoded.includes("\u0000")) {
    throw new MetisError(
      "EXTRACT_NOT_UTF8",
      `Source '${title}' contains NUL bytes, so it is binary rather than text.`,
    );
  }
  return decoded;
}

/** Normalize line endings and invisible whitespace without changing line count. */
export function normalizeText(text: string): string {
  return text
    .replace(/^\ufeff/, "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[\u00a0\u2007\u202f\u200b]/g, " ").trimEnd())
    .join("\n");
}

/**
 * Markdown keeps its body verbatim; only YAML frontmatter is blanked, because
 * metadata keys are not evidence but citations must still address raw-file
 * line numbers.
 */
export function extractMarkdownText(raw: string): string {
  const lines = normalizeText(raw).split("\n");
  if (lines[0]?.trim() !== "---") return lines.join("\n");
  const closing = lines.findIndex((line, index) =>
    index > 0 && (line.trim() === "---" || line.trim() === "..."));
  if (closing === -1) return lines.join("\n");
  for (let index = 0; index <= closing; index += 1) lines[index] = "";
  return lines.join("\n");
}

const LATEX_SECTIONS: Record<string, number> = {
  part: 1,
  chapter: 1,
  section: 2,
  subsection: 3,
  subsubsection: 4,
  paragraph: 5,
  subparagraph: 6,
};
const LATEX_SECTION_PATTERN =
  /^\s*\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?(?:\[[^\]]*\])?\{(.*)\}\s*$/;
const LATEX_ENVIRONMENT_PATTERN =
  /^\s*\\(?:begin|end)\{[A-Za-z*]+\}(?:\[[^\]]*\])?(?:\{[^{}]*\})*\s*$/;
const LATEX_TEXT_MACRO_PATTERN =
  /\\(?:textbf|textit|textsl|textsc|texttt|textrm|textsf|textnormal|emph|underline|text|mathrm|mathbf|mathit|mathsf|operatorname|caption|footnote|title|author)\*?\{([^{}]*)\}/g;
const LATEX_DROPPED_MACRO_PATTERN =
  /\\(?:label|index|hypertarget|vspace|hspace|bibliographystyle|bibliography|cite[a-zA-Z]*|ref|eqref|pageref)\*?(?:\[[^\]]*\])?\{[^{}]*\}/g;

/**
 * Reduce LaTeX to citable prose. The preamble, comments, environment markers,
 * and bookkeeping macros are blanked rather than deleted so every remaining
 * line keeps its original number, and sectioning commands become Markdown
 * headings so headings are discoverable the same way they are in Markdown.
 */
export function extractLatexText(raw: string): string {
  const lines = normalizeText(raw).split("\n").map(stripLatexComment);

  const documentStart = lines.findIndex((line) => line.includes("\\begin{document}"));
  if (documentStart !== -1) {
    for (let index = 0; index <= documentStart; index += 1) lines[index] = "";
    const documentEnd = lines.findIndex((line, index) =>
      index > documentStart && line.includes("\\end{document}"));
    if (documentEnd !== -1) {
      for (let index = documentEnd; index < lines.length; index += 1) lines[index] = "";
    }
  }

  return lines.map((raw) => {
    if (!raw.trim()) return "";
    // Bookkeeping macros are removed first so a trailing \\label does not end up
    // inside the captured section title.
    const line = stripLatexMacros(raw);
    const section = LATEX_SECTION_PATTERN.exec(line);
    if (section) {
      const level = LATEX_SECTIONS[section[1]!] ?? 3;
      const heading = cleanLatexInline(section[2] ?? "").trim();
      return heading ? `${"#".repeat(level)} ${heading}` : "";
    }
    if (LATEX_ENVIRONMENT_PATTERN.test(line)) return "";
    return cleanLatexInline(line).trimEnd();
  }).join("\n");
}

/** Remove a trailing `%` comment, honouring escaped percent signs. */
function stripLatexComment(line: string): string {
  let result = "";
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]!;
    if (character === "\\") {
      result += character + (line[index + 1] ?? "");
      index += 1;
      continue;
    }
    if (character === "%") break;
    result += character;
  }
  return result.trimEnd();
}

function stripLatexMacros(value: string): string {
  return value
    .replace(/\\href\{[^{}]*\}\{([^{}]*)\}/g, "$1")
    .replace(LATEX_DROPPED_MACRO_PATTERN, "");
}

function cleanLatexInline(value: string): string {
  let result = stripLatexMacros(value);
  for (let pass = 0; pass < 4; pass += 1) {
    const unwrapped = result.replace(LATEX_TEXT_MACRO_PATTERN, "$1");
    if (unwrapped === result) break;
    result = unwrapped;
  }
  return result
    .replace(/^\s*\\item\b\s*(?:\[[^\]]*\])?/, "- ")
    .replace(/\\\\\s*(?:\[[^\]]*\])?$/, "")
    .replace(/\\(?:par|noindent|centering|maketitle|tableofcontents|newpage|clearpage|linebreak|bigskip|medskip|smallskip)\b/g, "")
    .replace(/\\([%&_#${}])/g, "$1")
    .replace(/~/g, " ")
    .replace(/[ \t]{2,}/g, " ");
}

async function extractPdfText(absolutePath: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "pdftotext",
      ["-layout", "-nopgbrk", absolutePath, "-"],
      { maxBuffer: 64 * 1024 * 1024 },
    );
    return stdout;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === "ENOENT") {
      throw new MetisError(
        "EXTRACT_PDF_TOOL_MISSING",
        "PDF ingestion needs Poppler's `pdftotext` on PATH. Install Poppler and retry.",
        { detail: messageOf(error), cause: error },
      );
    }
    throw new MetisError(
      "EXTRACT_PDF_FAILED",
      "Could not extract text from this PDF. It may be encrypted, damaged, or image-only; export the pages as images to transcribe them instead.",
      { detail: messageOf(error), cause: error },
    );
  }
}

function hasUtf8Bom(bytes: Buffer): boolean {
  return bytes.byteLength >= 3
    && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
}
