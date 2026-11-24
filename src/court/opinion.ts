/**
 * The written opinion (SPEC §8.5). The outcome is decided in code before the LLM sees anything;
 * Ollama only writes. Thinking is off. One regeneration if the output fails validation, then a
 * template, so a hearing always closes.
 */
import { z } from "zod";
import { RecessError } from "../shared/budget.ts";
import type { Ollama } from "../shared/ollama.ts";

export interface OpinionFacts {
  kind: "ruled" | "too_close" | "contempt";
  caseNumber: number;
  title: string;
  caseType: string;
  plaintiff: string;
  defendant: string;
  claim: string;
  relief: string;
  winner?: string;
  loser?: string;
  lean?: string;
  contemnor?: string;
  vote?: string;
  confidencePct?: number;
  justices: { name: string; vote: string; personality?: string }[];
  dissenter?: string;
  dissenterPersonality?: string;
  sentence?: { level: number; text: string };
  inAbsentia?: string;
  articles: { number: number; title: string }[];
  filings: { author: string; kind: string; body: string }[];
  /** Set on the opinion on appeal. */
  appeal?: { by: string; evidence: string; original: string; result: "affirmed" | "reversed" };
}

export interface Opinion {
  opinion_md: string;
  bench_verdict: string;
  cited_articles: number[];
  source: "llm" | "template";
}

export const OpinionSchema = z.object({
  opinion_md: z.string().min(1),
  bench_verdict: z.string().min(1),
  cited_articles: z.array(z.number().int()),
});

export const FIXED_RULES = `Rules you always follow when writing an opinion:
- PG and kind. Never mean about anyone. This is a family court for laughs.
- Funny.
- At most 220 words for the opinion.
- Cite Family Code articles by number when relevant (only articles listed in the facts).
- State the court's confidence as a percentage, for example "The court is 73% sure".
- If the vote was 2–1, include a short dissent signed by the losing justice.
- The decision is already made. Write it; never change it.
- bench_verdict is spoken aloud: one or two sentences, at most 300 characters, and it must name the party it concerns.
- If there's a sentence, say it in bench_verdict only as "Sentence: <the sentence>." (the card shows it in its own box).
- Reply only with JSON: { "opinion_md": string, "bench_verdict": string, "cited_articles": number[] }.`;

export function opinionSystemPrompt(persona: string): string {
  return `${persona.trim()}\n\n${FIXED_RULES}`;
}

export function opinionUserPrompt(f: OpinionFacts): string {
  const lines: string[] = [];
  lines.push(`Case #${String(f.caseNumber).padStart(4, "0")}: ${f.title} (${f.caseType})`);
  lines.push(`Plaintiff: ${f.plaintiff}`, `Defendant: ${f.defendant}`, `Claim: ${f.claim}`, `Relief asked for: ${f.relief}`);
  if (f.kind === "ruled") {
    lines.push(`Decision: the court rules for ${f.winner}.`);
    lines.push(`Winner: ${f.winner}`, `Other party: ${f.loser}`);
    if (f.caseType === "petition" && f.winner === f.plaintiff) {
      lines.push("The petition is granted and recommended to the Executive Branch (a parent) for approval. The court can't change real house rules on its own.");
    }
  } else if (f.kind === "too_close") {
    lines.push("Decision: too close to call. The court orders a compromise. Propose one fair, specific compromise. No sentence.");
    lines.push(
      f.lean
        ? `The panel leaned slightly toward ${f.lean} (${f.vote}), but not enough to decide.`
        : `The panel split evenly (${f.vote}): the justices strongly disagree, each pulling a different way. Don't give a "% sure" number.`,
    );
    lines.push(`Winner: neither (compromise)`, `Other party: ${f.plaintiff} and ${f.defendant}`);
  } else {
    lines.push(`Decision: ${f.contemnor} is held in CONTEMPT OF COURT for trying to bribe, trick, flatter or boss around the court. Their filing is struck. Scold them, kindly, in the judge's voice.`);
    lines.push(`Winner: ${f.contemnor}`, `Other party: the court`);
  }
  if (f.appeal) {
    lines.push(
      `This is the opinion ON APPEAL. ${f.appeal.by} appealed with new evidence: "${f.appeal.evidence}".`,
      `The original ruling was ${f.appeal.original}. On appeal the court ${f.appeal.result === "affirmed" ? "AFFIRMS (keeps) it" : "REVERSES (changes) it"}. Say so clearly.`,
    );
  }
  if (f.vote) lines.push(`Vote: ${f.vote}`);
  if (f.confidencePct !== undefined) lines.push(`Confidence: ${f.confidencePct}%`);
  if (f.justices.length) lines.push(`Justices: ${f.justices.map((j) => `${j.name}: ${j.vote}`).join("; ")}`);
  const personalities = f.justices.filter((j) => j.personality);
  if (personalities.length) {
    lines.push(`When a justice speaks (like a dissent), use their personality: ${personalities.map((j) => `${j.name}: ${j.personality}`).join(" ")}`);
  }
  if (f.dissenter) lines.push(`Dissent: written by ${f.dissenter}${f.dissenterPersonality ? `, in their own voice (${f.dissenterPersonality})` : ""}`);
  if (f.sentence) lines.push(`Sentence (level ${f.sentence.level}): ${f.sentence.text}`);
  if (f.inAbsentia) lines.push(`Note: ${f.inAbsentia} was not heard; mention that the ruling was made in absentia.`);
  lines.push(
    f.articles.length
      ? `Family Code articles you may cite (only these; they are the ones relevant to this dispute): ${f.articles.map((a) => `Article ${a.number} (${a.title})`).join("; ")}`
      : "No Family Code article is relevant to this dispute, so don't cite any article.",
  );
  if (f.filings.length) {
    lines.push("Filings:");
    for (const fl of f.filings) lines.push(`- ${fl.author} (${fl.kind}): ${fl.body}`);
  }
  return lines.join("\n");
}

/** The spoken verdict must name the winner (or the contemnor). Too close: "compromise" or both parties. */
function namesTheRightParty(bench: string, f: OpinionFacts): boolean {
  const b = bench.toLowerCase();
  const has = (s?: string) => !!s && b.includes(s.toLowerCase());
  if (f.kind === "ruled") return has(f.winner);
  if (f.kind === "contempt") return has(f.contemnor);
  return b.includes("compromise") || (has(f.plaintiff) && has(f.defendant));
}

export function validateOpinion(o: z.infer<typeof OpinionSchema>, f: OpinionFacts): string | null {
  if (o.bench_verdict.length > 300) return "bench verdict too long";
  if (!namesTheRightParty(o.bench_verdict, f)) return "bench verdict doesn't name the right party";
  const words = o.opinion_md.trim().split(/\s+/).length;
  if (words > 300) return "opinion too long";
  // Only articles judged relevant may be cited, in the list or anywhere in the text.
  const allowed = new Set(f.articles.map((a) => a.number));
  const mentioned = [...`${o.opinion_md} ${o.bench_verdict}`.matchAll(/\bArticles?\s+(\d+)/gi)].map((m) => Number(m[1]));
  const stray = [...new Set([...mentioned, ...o.cited_articles])].filter((n) => !allowed.has(n));
  if (stray.length) return `cites an article that isn't relevant (Article ${stray.join(", ")})`;
  return null;
}

export function templateOpinion(f: OpinionFacts): Opinion {
  const num = `Case #${String(f.caseNumber).padStart(4, "0")}`;
  const pct = f.confidencePct !== undefined ? ` The court is ${f.confidencePct}% sure.` : "";
  const absentia = f.inAbsentia ? ` (${f.inAbsentia} was not heard, so this ruling was made in absentia.)` : "";
  let body: string;
  let bench: string;
  if (f.kind === "contempt") {
    body = `**${num}: ${f.title}**\n\n${f.contemnor} tried to sway this court with something other than arguments. That is **contempt of court**, and the filing is struck.${f.sentence ? `\n\n**Sentence:** ${f.sentence.text}` : ""}\n\nArgue your case, not your snacks. So ordered.`;
    bench = `${f.contemnor} is held in contempt of court! Nice try. ${f.sentence ? f.sentence.text + "." : ""}`;
  } else if (f.kind === "too_close") {
    const lean = f.lean ? ` The panel leaned toward ${f.lean} (${f.vote}), but not by enough.` : f.vote ? ` The justices split ${f.vote} and strongly disagree.` : "";
    body = `**${num}: ${f.title}**\n\nThis one is too close to call.${lean}${pct} The court orders a **compromise**: ${f.plaintiff} and ${f.defendant} take turns, starting with whoever lost the last coin toss.${absentia}\n\nSo ordered.`;
    bench = `Too close to call! The court orders a compromise between ${f.plaintiff} and ${f.defendant}.`;
  } else {
    const petition = f.caseType === "petition" && f.winner === f.plaintiff ? " The petition is recommended to the Executive Branch (a parent) for approval." : "";
    body = `**${num}: ${f.title}**\n\nThe court rules for **${f.winner}**, by a vote of ${f.vote}.${pct}${petition}${absentia}${f.sentence ? `\n\n**Sentence:** ${f.sentence.text}` : ""}${f.dissenter ? `\n\n*${f.dissenter} dissents.*` : ""}\n\nSo ordered.`;
    bench = `The court rules for ${f.winner}!${f.sentence ? ` Sentence: ${f.sentence.text}.` : ""}`;
  }
  if (f.appeal) {
    const word = f.appeal.result === "affirmed" ? "AFFIRMED" : "REVERSED";
    body = `**${word} on appeal.** ${f.appeal.by} brought new evidence, and the court took a fresh look.\n\n${body}`;
    bench = `On appeal, ${word.toLowerCase()}! ${bench}`;
  }
  return { opinion_md: body, bench_verdict: bench.slice(0, 300), cited_articles: [], source: "template" };
}

export async function writeOpinion(ollama: Ollama, persona: string, f: OpinionFacts, log: (m: string) => void = console.log): Promise<Opinion> {
  const known = new Set(f.articles.map((a) => a.number));
  const messages = [
    { role: "system" as const, content: opinionSystemPrompt(persona) },
    { role: "user" as const, content: opinionUserPrompt(f) },
  ];
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const o = await ollama.chatJson(OpinionSchema, { messages, think: false, options: { temperature: 0.8 } });
      const problem = validateOpinion(o, f);
      if (!problem) {
        return { ...o, cited_articles: [...new Set(o.cited_articles.filter((n) => known.has(n)))], source: "llm" };
      }
      log(`[opinion] attempt ${attempt} rejected: ${problem}`);
    } catch (err) {
      if (err instanceof RecessError) break; // out of Ollama budget: go straight to the template
      log(`[opinion] attempt ${attempt} failed: ${(err as Error).message}`);
    }
  }
  return templateOpinion(f);
}
