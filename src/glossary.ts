import { readFileSync } from "node:fs";
import { config } from "./config.js";
import { LANGUAGES, type LangCode } from "./languages.js";

/**
 * A term whose translation must stay identical every time it appears -
 * ministry names, recurring events, people. Without this, an LLM will happily
 * render "Zion Church" three different ways across one conversation.
 */
export interface GlossaryEntry {
  term: string;
  translations: Partial<Record<LangCode, string>>;
  note?: string;
}

function loadGlossary(): GlossaryEntry[] {
  try {
    const raw = readFileSync(config.GLOSSARY_FILE, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      console.warn(`[glossary] ${config.GLOSSARY_FILE} is not a JSON array - ignoring.`);
      return [];
    }
    return parsed.filter(
      (e): e is GlossaryEntry =>
        typeof e === "object" && e !== null && typeof (e as GlossaryEntry).term === "string",
    );
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      console.warn(`[glossary] could not read ${config.GLOSSARY_FILE}:`, err);
    }
    return [];
  }
}

export const glossary: GlossaryEntry[] = loadGlossary();

/**
 * Rendered once at startup and embedded in the cached system prompt. Entries are
 * sorted so the text is byte-identical across restarts - a varying prefix would
 * silently destroy the prompt cache hit rate.
 */
export function renderGlossary(): string {
  if (glossary.length === 0) return "";
  const lines = [...glossary]
    .sort((a, b) => a.term.localeCompare(b.term))
    .map((entry) => {
      const renderings = Object.entries(entry.translations)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([code, value]) => `${LANGUAGES[code as LangCode]?.name ?? code}: ${value}`)
        .join(" | ");
      return `- ${entry.term} => ${renderings}${entry.note ? ` (${entry.note})` : ""}`;
    });
  return [
    "<glossary>",
    "These terms are fixed. Use exactly these renderings, never a synonym:",
    ...lines,
    "</glossary>",
  ].join("\n");
}
