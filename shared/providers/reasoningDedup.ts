const THINK_PAIR_RE = /<think>[\s\S]*?<\/think>/g;

const TEMPLATE_ECHO_RE =
  /\{\s*"action"\s*:\s*"<action>"\s*,\s*"reasoning"\s*:\s*"<why>"/;


const SEGMENT_TERMINATORS = new RegExp(
  "(?:" +
    "\\nAction:\\s*\\w+" +
    "|\\nActing:\\s*\\w+" +
    "|\\nLogic:" +
    "|\\nnotepad_update:" +
    "|\\nNotepad:" +
    "|\\n## Output:" +
    "|</think>" +
    '|\\n\\s*\\{"action"' +
    "|\\nChoose your next action" +
    "|\\nRespond with JSON" +
    "|\\nPlease respond with" +
    ")",
);

const REASONING_MARKER_RE = /Reasoning:\s*/gi;


const CLEAN_PATTERNS: Array<[RegExp, string]> = [
  [/<\/think>/g, ""],
  [/^Reasoning:\s*/gm, ""],
  [/^Action:\s*\w+\s*/gm, ""],
  [/^Acting:\s*\w+\s*/gm, ""],
  [/^Logic:.*$/gm, ""],
  [/notepad_update:.*$/gm, ""],
  [/^Notepad:.*$/gm, ""],
  [/^## Output:.*$/gm, ""],
  [/^Choose your next action.*$/gm, ""],
  [/^Respond with JSON.*$/gm, ""],
  [/^Please respond with.*$/gm, ""],
];

const MULTI_NEWLINE_RE = /\n{3,}/g;

// --- Core Algorithm ---

function capAtSentenceBoundary(
  text: string,
  target = 2500,
  window = 200,
): string {
  if (text.length <= target + window) return text;

  const searchStart = Math.max(0, target - window);
  const searchEnd = Math.min(text.length, target + window);
  const searchRegion = text.slice(searchStart, searchEnd);

  // Find last sentence-ending punctuation in the window
  const sentenceEnds = [...searchRegion.matchAll(/[.!?](?:\s|$)/g)];
  if (sentenceEnds.length > 0) {
    const lastEnd = sentenceEnds[sentenceEnds.length - 1]!;
    const cutPos = searchStart + lastEnd.index! + lastEnd[0].length;
    return text.slice(0, cutPos).trimEnd();
  }

  // No sentence boundary found — hard cut at target
  return text.slice(0, target);
}

function extractSegments(text: string): string[] {
  const stripped = text.replace(THINK_PAIR_RE, "");

  const segments: string[] = [];
  const markerRe = new RegExp(REASONING_MARKER_RE.source, "gi");
  let m: RegExpExecArray | null;
  while ((m = markerRe.exec(stripped)) !== null) {
    const start = m.index + m[0].length;
    const termMatch = SEGMENT_TERMINATORS.exec(stripped.slice(start));
    let segText: string;
    if (termMatch) {
      segText = stripped.slice(start, start + termMatch.index);
    } else {
      segText = stripped.slice(start);
    }
    segText = segText.trim();
    if (segText) {
      segments.push(segText);
    }
  }

  return segments;
}

function cleanSegment(segment: string): string {
  let result = segment;
  for (const [pattern, replacement] of CLEAN_PATTERNS) {
    // Reset lastIndex for global regexes
    pattern.lastIndex = 0;
    result = result.replace(pattern, replacement);
  }

  // Split at template JSON echo (keep only text before it)
  const echoIdx = result.search(TEMPLATE_ECHO_RE);
  if (echoIdx !== -1) {
    result = result.slice(0, echoIdx);
  }

  result = result.replace(MULTI_NEWLINE_RE, "\n\n");
  return result.trim();
}


function shouldAccept(
  candidate: string,
  acceptedSegments: string[],
  threshold = 0.75,
): boolean {
  const wordsCandidate = new Set(
    candidate
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 0),
  );
  if (wordsCandidate.size === 0) return false;

  for (const prior of acceptedSegments) {
    const wordsPrior = new Set(
      prior
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 0),
    );
    if (wordsPrior.size === 0) continue;

    let shared = 0;
    wordsCandidate.forEach((word) => {
      if (wordsPrior.has(word)) shared++;
    });

    // C1 fix: denominator = candidate word count (not min)
    const overlap = shared / wordsCandidate.size;
    if (overlap >= threshold) return false;
  }
  return true;
}


function cleanNoMarkersContent(text: string): string {
  let result = text.replace(THINK_PAIR_RE, "");
  result = result.replace(/<\/think>/g, "");
  result = result.replace(/notepad_update:.*$/gm, "");
  result = result.replace(/^Notepad:.*$/gm, "");
  result = result.replace(/\nAction:\s*\w+/g, "");
  result = result.replace(/\nActing:\s*\w+/g, "");
  result = result.replace(/\nLogic:.*/g, "");
  result = result.replace(/^Reasoning:\s*/gm, "");

  // Split at template echo
  const echoIdx = result.search(TEMPLATE_ECHO_RE);
  if (echoIdx !== -1) {
    result = result.slice(0, echoIdx);
  }

  // Truncate at prompt template fragments
  const fragments = [
    "Choose your next action",
    "Please respond with valid JSON:",
    "Please respond with",
    "Respond with JSON:",
    "Respond with JSON",
  ];
  for (const fragment of fragments) {
    const idx = result.indexOf(fragment);
    if (idx !== -1) {
      result = result.slice(0, idx);
    }
  }

  result = result.replace(MULTI_NEWLINE_RE, "\n\n");
  return result.trim();
}


export function extractDeduplicatedReasoning(text: string): string {
  const segments = extractSegments(text);

  // No Reasoning: markers found — clean full content
  if (segments.length === 0) {
    const cleaned = cleanNoMarkersContent(text);
    if (!cleaned) return "";
    return capAtSentenceBoundary(cleaned);
  }

  // Single segment — clean and cap, no dedup needed
  if (segments.length === 1) {
    const cleaned = cleanSegment(segments[0]!);
    return cleaned ? capAtSentenceBoundary(cleaned) : "";
  }

  // Multiple segments — dedup pipeline
  const accepted: string[] = [];
  for (const seg of segments) {
    const cleaned = cleanSegment(seg);
    if (cleaned && shouldAccept(cleaned, accepted)) {
      accepted.push(cleaned);
    }
  }

  // All rejected — fall back to first segment
  if (accepted.length === 0) {
    const firstCleaned = cleanSegment(segments[0]!);
    return firstCleaned ? capAtSentenceBoundary(firstCleaned) : "";
  }


  let result = accepted.join("\n");

  // Final clean: strip any remaining markers that leaked through
  result = result.replace(/^(Action|Acting|Reasoning|Logic):\s*/gm, "");
  result = result.replace(/notepad_update:.*$/gm, "");
  result = result.replace(/^Notepad:.*$/gm, "");
  result = result.replace(MULTI_NEWLINE_RE, "\n\n");
  result = result.trim();

  result = result.replace(/^[:\s]+/, "");

  return capAtSentenceBoundary(result);
}
