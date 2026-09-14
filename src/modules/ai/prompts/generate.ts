/**
 * Prompt templates (M10). PLAN.md §25.1.
 *
 * Prompts live in code and every job records `prompt_version`, so a change in
 * output quality can be attributed to a change in the prompt by querying
 * acceptance rate per version. Without that, prompt iteration is guesswork.
 */

/**
 * Bump this whenever the wording below changes materially.
 *
 * v1 — initial.
 * v2 — (M13) adds the coverage digest block.
 */
export const PROMPT_VERSION = "v2-coverage";

export type GenerationPromptInput = {
  topic: string;
  subtopics?: string[] | null;
  difficulty?: string | null;
  examBody?: string | null;
  count: number;
  brief: string;
  /** Compressed list of facts the bank already covers (M13). */
  coverageDigest?: string | null;
  avoidTopics?: string[] | null;
};

export function buildSystemPrompt(): string {
  return [
    "You are an expert exam-question author for competitive and school-level quizzes.",
    "You write multiple-choice questions with exactly four options.",
    "",
    "HARD RULES",
    "1. Output ONLY valid JSON. No markdown fences, no commentary, no preamble.",
    "2. Match the requested JSON schema exactly, using the exact key names given.",
    "3. Exactly one option is correct, identified by correct_option_key.",
    "4. Distractors must be plausible and of similar length and specificity to the answer.",
    '5. Never write "All of the above" or "None of the above".',
    "6. The stem must not contain the correct answer's wording.",
    "7. Every question needs a backstory of at least three sentences of genuine context —",
    "   history, mechanism, or a memorable fact. It must not merely restate the answer.",
    "   Markdown is allowed and a table or blockquote is welcome where it helps.",
    "8. Do not create questions that test facts listed under ALREADY COVERED.",
    "9. Never invent facts. If you are unsure of a detail, choose a different question.",
  ].join("\n");
}

export function buildUserPrompt(input: GenerationPromptInput): string {
  const lines: string[] = [
    `TOPIC: ${input.topic}`,
    `SUBTOPICS: ${input.subtopics?.length ? input.subtopics.join(", ") : "(none specified)"}`,
    `DIFFICULTY: ${input.difficulty ?? "medium"}`,
    `STYLE / EXAM BODY: ${input.examBody ?? "general competitive exam"}`,
    `COUNT: ${input.count}`,
    "",
    "ADMIN BRIEF:",
    input.brief.trim() || "(no extra instructions)",
    "",
  ];

  if (input.coverageDigest?.trim()) {
    lines.push(
      "ALREADY COVERED (do NOT test these facts):",
      input.coverageDigest.trim(),
      "",
      "If covering a listed concept is unavoidable, it must require a materially different,",
      "deeper fact than the one already covered.",
      "",
    );
  }

  if (input.avoidTopics?.length) {
    lines.push("ADDITIONALLY AVOID:", input.avoidTopics.join(", "), "");
  }

  lines.push(
    "Return JSON with exactly this shape:",
    JSON.stringify(
      {
        questions: [
          {
            stem: "…",
            options: [
              { key: "A", body: "…" },
              { key: "B", body: "…" },
              { key: "C", body: "…" },
              { key: "D", body: "…" },
            ],
            correct_option_key: "B",
            explanation: "one or two sentences",
            backstory: "markdown; three or more sentences",
            difficulty: "medium",
            topic: input.topic,
            tags: ["…"],
          },
        ],
      },
      null,
      2,
    ),
  );

  return lines.join("\n");
}
