import { type BugCandidate, bugCandidate } from "./community-bug-facts";

export function bugReportCandidates(messageId: string, report: string): BugCandidate[] {
  const candidates = [bugCandidate("actual", messageId, report)];
  const expected = /애초에\s+(.+?)(?:[.!?]|$)/u.exec(report);
  if (!expected?.[1]) return candidates;
  const quote = expected[1].trim();
  const start = report.indexOf(quote);
  candidates.push({
    ...bugCandidate("expected", messageId, quote),
    start,
    end: start + quote.length,
  });
  return candidates;
}
