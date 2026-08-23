import type Database from "better-sqlite3";
import OpenAI from "openai";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import { recordUsage } from "../db.js";
import { gmailMessageForModel } from "../services/gmail.js";
import type { EmailMatchResult, EmailRule, GmailMessage } from "../types.js";
import { EMAIL_CLASSIFIER_SYSTEM_PROMPT } from "./prompts.js";

const matchSchema = z.object({
  match: z.boolean(),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1).max(500),
  summary: z.string().min(1).max(1000),
});

export class EmailClassifier {
  constructor(
    private readonly client: OpenAI,
    private readonly config: AppConfig,
    private readonly database: Database.Database,
  ) {}

  async classify(
    rule: EmailRule,
    message: GmailMessage,
    callerSignal?: AbortSignal,
  ): Promise<EmailMatchResult> {
    const timeoutSignal = AbortSignal.timeout(
      this.config.EMAIL_CLASSIFIER_TIMEOUT_SECONDS * 1000,
    );
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, timeoutSignal])
      : timeoutSignal;
    const completion = await this.client.chat.completions.create(
      {
        model: this.config.OPENAI_CLASSIFIER_MODEL,
        messages: [
          { role: "system", content: EMAIL_CLASSIFIER_SYSTEM_PROMPT },
          {
            role: "user",
            content: [
              `Aturan pengguna:\n${rule.description}`,
              rule.gmailQuery
                ? `Hint filter Gmail (petunjuk tambahan, bukan hard-negative): ${rule.gmailQuery}`
                : "",
              gmailMessageForModel(message),
            ]
              .filter(Boolean)
              .join("\n\n"),
          },
        ],
        response_format: { type: "json_object" },
        max_completion_tokens: 400,
      },
      { signal },
    );
    recordUsage(
      this.database,
      "email-classification",
      this.config.OPENAI_CLASSIFIER_MODEL,
      completion.usage?.prompt_tokens ?? 0,
      completion.usage?.completion_tokens ?? 0,
    );
    const content = completion.choices[0]?.message.content;
    if (!content) throw new Error("Model tidak mengembalikan hasil klasifikasi email.");
    return matchSchema.parse(JSON.parse(content));
  }
}

export { matchSchema };
