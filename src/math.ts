import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { StudyStore } from "./store.js";
import { asError, atomicWrite, nowIso, sanitizeFilename } from "./util.js";

const execFileAsync = promisify(execFile);

export interface MathVerification {
  ok: boolean;
  error?: string;
  errorType?: string;
  operation?: "evaluate" | "solve";
  expression?: string;
  variables?: Record<string, string | number>;
  solveFor?: string;
  result?: {
    exact: string;
    decimal: string;
    latex: string;
    isReal: boolean | null;
  };
  solutions?: Array<{
    exact: string;
    decimal: string;
    latex: string;
    isReal: boolean | null;
  }>;
  method?: string;
  warnings?: string[];
  truncated?: boolean;
  verifiedBy?: string;
}

export class MathService {
  constructor(private readonly store: StudyStore) {}

  async verify(input: {
    expression: string;
    operation?: "evaluate" | "solve";
    variables?: Record<string, string | number>;
    solveFor?: string;
    initialGuess?: number;
    precision?: number;
  }): Promise<MathVerification> {
    const script = await findPythonScript();
    const python = process.env.METIS_PYTHON?.trim() || "python3";
    const payload = JSON.stringify({
      expression: input.expression,
      operation: input.operation ?? "evaluate",
      variables: input.variables ?? {},
      ...(input.solveFor ? { solveFor: input.solveFor } : {}),
      ...(input.initialGuess !== undefined ? { initialGuess: input.initialGuess } : {}),
      precision: input.precision ?? 30,
    });
    try {
      const { stdout, stderr } = await execFileAsync(python, [script, payload], {
        timeout: 15_000,
        maxBuffer: 2 * 1024 * 1024,
      });
      if (stderr.trim()) {
        throw new Error(stderr.trim());
      }
      const parsed = JSON.parse(stdout) as MathVerification;
      const compact = compactVerification(parsed);
      await this.store.appendLog("math", input.expression, [
        `Operation: ${input.operation ?? "evaluate"}`,
        `Verified: ${compact.ok ? "yes" : "no"}`,
        compact.verifiedBy ? `Runtime: ${compact.verifiedBy}` : `Error: ${compact.error ?? "unknown"}`,
      ]);
      return compact;
    } catch (error) {
      throw new Error(`Python verification failed: ${asError(error).message}`);
    }
  }

  async renderPdf(input: {
    title: string;
    latexBody: string;
    outputName?: string;
    author?: string;
  }): Promise<{
    pdfPath: string;
    texPath: string;
    compiledAt: string;
    compiler: string;
    bytes: number;
  }> {
    validateLatexBody(input.latexBody);
    const stem = sanitizeFilename(input.outputName ?? input.title, "study-export").replace(/\.pdf$/i, "");
    const exportsDir = await this.store.resolveExisting("exports");
    const texPath = await this.store.resolveForWrite(
      path.posix.join("exports", `${stem}.tex`),
    );
    const pdfPath = await this.store.resolveForWrite(
      path.posix.join("exports", `${stem}.pdf`),
    );
    const latex = buildLatexDocument(input.title, input.latexBody, input.author);
    await atomicWrite(texPath, latex);

    const compiler = process.env.METIS_LATEX?.trim() || "pdflatex";
    try {
      await execFileAsync(compiler, [
        "-no-shell-escape",
        "-interaction=nonstopmode",
        "-halt-on-error",
        `-output-directory=${exportsDir}`,
        texPath,
      ], {
        cwd: exportsDir,
        timeout: 60_000,
        maxBuffer: 5 * 1024 * 1024,
      });
    } catch (error) {
      const details = asError(error) as Error & { stdout?: string; stderr?: string };
      const diagnostic = [details.message, details.stdout, details.stderr]
        .filter(Boolean)
        .join("\n")
        .slice(-6000);
      throw new Error(`LaTeX compilation failed. The source remains at ${texPath}.\n${diagnostic}`);
    }
    const bytes = (await readFile(pdfPath)).byteLength;
    const compiledAt = nowIso();
    await this.store.appendLog("export", input.title, [
      `PDF: \`exports/${path.basename(pdfPath)}\``,
      `TeX: \`exports/${path.basename(texPath)}\``,
      `Compiler: ${compiler} with shell escape disabled`,
    ]);
    return { pdfPath, texPath, compiledAt, compiler, bytes };
  }
}

function compactVerification(value: MathVerification): MathVerification {
  if (!value.ok) {
    return {
      ok: false,
      ...(value.error ? { error: value.error.slice(0, 1_000) } : {}),
      ...(value.errorType ? { errorType: value.errorType.slice(0, 120) } : {}),
    };
  }
  let truncated = false;
  const compactValue = (
    item: NonNullable<MathVerification["result"]>,
  ): NonNullable<MathVerification["result"]> => {
    const limit = (text: string, maximum: number): string => {
      if (text.length <= maximum) return text;
      truncated = true;
      return `${text.slice(0, maximum)}…[${text.length} chars]`;
    };
    return {
      exact: limit(item.exact, 1_200),
      decimal: limit(item.decimal, 500),
      latex: limit(item.latex, 1_200),
      isReal: item.isReal,
    };
  };
  const allSolutions = value.solutions ?? [];
  if (allSolutions.length > 10) truncated = true;
  const result = value.result ? compactValue(value.result) : undefined;
  const solutions = allSolutions.slice(0, 10).map(compactValue);
  return {
    ok: true,
    ...(value.operation ? { operation: value.operation } : {}),
    ...(result ? { result } : {}),
    ...(value.solutions ? { solutions } : {}),
    ...(value.method ? { method: value.method.slice(0, 200) } : {}),
    ...(value.warnings
      ? { warnings: value.warnings.slice(0, 5).map((warning) => warning.slice(0, 500)) }
      : {}),
    ...(truncated ? { truncated: true } : {}),
    ...(value.verifiedBy ? { verifiedBy: value.verifiedBy.slice(0, 200) } : {}),
  };
}

async function findPythonScript(): Promise<string> {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(moduleDirectory, "../../python/verify_math.py"),
    path.resolve(moduleDirectory, "../python/verify_math.py"),
    path.resolve(process.cwd(), "python/verify_math.py"),
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  throw new Error("Could not locate python/verify_math.py in the installed package.");
}

function validateLatexBody(body: string): void {
  if (!body.trim()) throw new Error("latexBody cannot be empty.");
  if (body.length > 500_000) throw new Error("latexBody exceeds the 500 KB limit.");
  const unsafe = /\\(?:input|include|includeonly|openin|openout|read|write|write18|immediate|catcode|csname|usepackage|documentclass)\b/i;
  const match = body.match(unsafe);
  if (match) {
    throw new Error(`Unsafe or preamble-only LaTeX command is not allowed in latexBody: ${match[0]}`);
  }
}

function escapeLatexText(value: string): string {
  return value.replace(/[#$%&_{}~^\\]/g, (character) => {
    const replacements: Record<string, string> = {
      "#": "\\#",
      "$": "\\$",
      "%": "\\%",
      "&": "\\&",
      "_": "\\_",
      "{": "\\{",
      "}": "\\}",
      "~": "\\textasciitilde{}",
      "^": "\\textasciicircum{}",
      "\\": "\\textbackslash{}",
    };
    return replacements[character] ?? character;
  });
}

function buildLatexDocument(title: string, body: string, author?: string): string {
  return String.raw`\documentclass[11pt]{article}
\usepackage[margin=25mm]{geometry}
\usepackage{amsmath,amssymb,mathtools}
\usepackage{microtype}
\usepackage{xcolor}
\usepackage{enumitem}
\usepackage[hidelinks]{hyperref}
\definecolor{MetisInk}{HTML}{17202A}
\definecolor{MetisAccent}{HTML}{2457C5}
\setlength{\parindent}{0pt}
\setlength{\parskip}{0.7em}
\setlist{nosep}
\title{\color{MetisInk}\textbf{${escapeLatexText(title)}}}
${author?.trim() ? `\\author{${escapeLatexText(author.trim())}}` : "\\author{}"}
\date{}
\begin{document}
\maketitle
\color{MetisInk}
${body.trim()}
\end{document}
`;
}
