/**
 * The official court record filed to Box as Case-0007.md (SPEC §6.4). Built from the same view
 * the browser gets, so it only ever contains court aliases.
 */
import type { caseView } from "./views.ts";

type View = ReturnType<typeof caseView>;

export const recordName = (n: number) => `Case-${String(n).padStart(4, "0")}.md`;

const OUTCOME: Record<string, string> = {
  contempt: "Held in contempt of court",
  compromise: "Too close to call: compromise ordered",
};

export function renderRecord(v: View, courtName: string, filedAt: Date = new Date()): string {
  const r = v.ruling;
  const lines: string[] = [];
  lines.push(`# ${courtName}: ${v.label}`, "");
  const a = v.appeal;
  if (a?.status === "affirmed" || a?.status === "reversed") lines.push(`> **${a.status.toUpperCase()} on appeal**`, "");
  if (a?.status === "dismissed") lines.push(`> **APPEAL DISMISSED** (${a.reason === "contempt" ? "contempt of court" : "nothing new"})`, "");
  lines.push(`## ${v.title}`, "");
  lines.push(`- **Parties:** ${v.plaintiff} v. ${v.defendant}`);
  lines.push(`- **Type:** ${v.type ?? "unknown"} · filed ${v.filedBy === "lawyer" ? "by counsel" : "pro se"} on ${new Date(v.createdAt).toISOString().slice(0, 10)}`);
  if (r) {
    const outcome = r.winner ? `For ${r.winner}` : OUTCOME[r.outcome ?? ""] ?? r.outcome ?? "";
    lines.push(`- **Outcome:** ${outcome}${r.vote ? ` (vote ${r.vote})` : ""}${r.lean ? `, leaning ${r.lean.party} ${r.lean.vote}` : ""}`);
    if (r.confidencePct != null && r.outcome !== "contempt") lines.push(`- **Confidence:** ${r.confidencePct}%`);
    if (r.sentence) lines.push(`- **Sentence (level ${r.sentence.level}):** ${r.sentence.text}`);
    if (r.petitionRecommended) {
      const a = v.approval === "approved" ? "APPROVED by the Executive Branch" : v.approval === "denied" ? "NOT approved by the Executive Branch" : "awaiting the Executive Branch (a parent)";
      lines.push(`- **Petition:** ${a}`);
    }
    if (r.citedArticles.length) lines.push(`- **Cites:** ${r.citedArticles.map((a) => `Article ${a.number}${a.title ? ` (${a.title})` : ""}`).join(", ")}`);
    if (r.seats.length) {
      lines.push("", "### The panel", "");
      for (const s of r.seats as any[]) {
        if (s.status === "voted") {
          const cites = s.cites?.length ? `, citing ${s.cites.map((c: any) => `${c.label}${c.title ? ` (${c.title})` : ""}`).join("; ")}` : "";
          lines.push(`- **${s.name}:** ${s.party} (${s.pct}%)${cites}`);
        } else {
          lines.push(`- **${s.name}:** ${s.reason}`);
        }
      }
    }
    if (r.opinionMd) lines.push("", "### Opinion of the Court", "", r.opinionMd.trim());
    if (r.benchVerdict) lines.push("", `> ${r.benchVerdict}`);
  }
  if (a?.status) {
    lines.push("", "### Appeal", "", `- **By:** ${a.by}`, `- **Result:** ${a.status === "pending" ? "being heard" : a.status}`, `- **New evidence:** ${a.evidence.replace(/\s*\n\s*/g, " ")}`);
  }
  lines.push("", "### Filings", "");
  for (const f of v.filings) lines.push(`- **${f.author}** (${f.kind})${f.struck ? " · STRUCK FROM THE RECORD" : ""}: ${f.body.replace(/\s*\n\s*/g, " ")}`);
  lines.push("", "---", `_Filed by the Clerk of the Court, ${filedAt.toISOString().replace("T", " ").slice(0, 16)} UTC._`, "");
  return lines.join("\n");
}
