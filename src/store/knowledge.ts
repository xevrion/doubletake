import { readFileSync } from "node:fs";
import type { GroundingSource } from "../policy/types.ts";

// The demo company's policy documents.
//
// Worth being clear about the boundary: DoubleTake does not own a knowledge
// base. A caller passes grounding sources in with each request, because in a
// real deployment those come from the enterprise's own retrieval system and
// change far more often than the gateway does. This file exists only so the
// console, the traffic seeder and the evaluation set all cite one consistent
// fictional company instead of three drifting copies.

interface KnowledgeFile {
  company: string;
  documents: (GroundingSource & { title: string })[];
}

let cache: KnowledgeFile | null = null;

export function knowledgeBase(): KnowledgeFile {
  if (!cache) {
    cache = JSON.parse(readFileSync("data/knowledge-base.json", "utf8")) as KnowledgeFile;
  }
  return cache;
}

export function allDocuments(): GroundingSource[] {
  return knowledgeBase().documents.map(({ id, title, text }) => ({ id, title, text }));
}

export function documentsFor(ids: string[]): GroundingSource[] {
  const byId = new Map(allDocuments().map((d) => [d.id, d]));
  return ids.map((id) => byId.get(id)).filter((d): d is GroundingSource => d !== undefined);
}
