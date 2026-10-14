import assert from "node:assert/strict";

export type NeuclirTopicMode = "full" | "description" | "title_description";
export type NeuclirTopicText = {
  lang: "eng";
  source: "original";
  topic_title: string;
  topic_description: string;
  topic_narrative?: string;
};
export type NeuclirTopicInput = {
  query_id: string;
  query: string;
  topic_fields: string[];
  topic?: NeuclirTopicText;
};

function record(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), "Invalid topic object");
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string): string {
  assert.ok(typeof value === "string" && value.trim(), `Missing NeuCLIR ${field}`);
  return value;
}

function topicId(value: unknown): string {
  assert.ok(
    (typeof value === "string" && /^\d+$/.test(value)) ||
      (typeof value === "number" && Number.isSafeInteger(value) && value >= 0),
    "Missing or invalid NeuCLIR topic ID",
  );
  return String(value);
}

export function neuclirTopicMode(value: string): NeuclirTopicMode {
  assert.ok(
    value === "full" || value === "description" || value === "title_description",
    "Topic mode must be full, title_description or description",
  );
  return value;
}

/** Select the official English original, without labels or translated alternatives. */
export function normalizeNeuclirTopic(
  value: unknown,
  mode: NeuclirTopicMode = "title_description",
): NeuclirTopicInput {
  const row = record(value);
  const query_id = topicId(row.topic_id ?? row.query_id);
  if (row.topic_id !== undefined && row.query_id !== undefined)
    assert.equal(topicId(row.topic_id), topicId(row.query_id), "Conflicting topic IDs");

  let selected: Record<string, unknown>;
  if (Array.isArray(row.topics)) {
    const originals = row.topics
      .map(record)
      .filter((t) => t.lang === "eng" && t.source === "original");
    assert.equal(originals.length, 1, "Expected exactly one original English NeuCLIR topic");
    selected = originals[0];
  } else if (row.topic !== undefined) {
    selected = record(row.topic);
    assert.equal(selected.lang, "eng", "Expected the English topic");
    assert.equal(selected.source, "original", "Expected the original topic");
  } else {
    assert.equal(
      mode,
      "description",
      `NeuCLIR ${mode} input requires official topic fields; use --topic-mode description for description-only input`,
    );
    return { query_id, query: text(row.query, "description"), topic_fields: ["description"] };
  }

  const description = text(selected.topic_description, "description");
  if (mode === "description")
    return { query_id, query: description, topic_fields: ["description"] };

  const topic: NeuclirTopicText = {
    lang: "eng",
    source: "original",
    topic_title: text(selected.topic_title, "title"),
    topic_description: description,
    ...(mode === "full" ? { topic_narrative: text(selected.topic_narrative, "narrative") } : {}),
  };
  return {
    query_id,
    query:
      `Title: ${topic.topic_title}\n\nDescription: ${topic.topic_description}` +
      (mode === "full" ? `\n\nNarrative: ${topic.topic_narrative}` : ""),
    topic_fields:
      mode === "full" ? ["title", "description", "narrative"] : ["title", "description"],
    topic,
  };
}

export function neuclirQueryTsv(topics: NeuclirTopicInput[]): string {
  return (
    topics.map((t) => `${t.query_id}\t${t.query.replace(/[\t\r\n]+/g, " ")}`).join("\n") + "\n"
  );
}
