/**
 * AI Image Analysis Service
 * @module api-v1-images/services/ai
 */

import type { AIData } from "../types/index.ts";
import { logger } from "../../_shared/logger.ts";

export async function analyzeImage(imageUrl: string): Promise<AIData | null> {
  const HF_TOKEN = Deno.env.get("HUGGINGFACE_TOKEN");

  if (!HF_TOKEN) {
    logger.warn("HuggingFace token not configured, skipping AI analysis");
    return null;
  }

  try {
    const response = await fetch(
      "https://api-inference.huggingface.co/models/nateraw/food",
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${HF_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ inputs: imageUrl }),
      },
    );

    if (!response.ok) {
      logger.warn("AI analysis failed", {
        status: response.status,
        statusText: response.statusText,
      });
      return null;
    }

    const predictions = await response.json();

    if (!Array.isArray(predictions) || predictions.length === 0) {
      return null;
    }

    // Take top 5 predictions
    const topPredictions = predictions.slice(0, 5);

    return {
      tags: topPredictions.map((p: any) => p.label),
      confidence: topPredictions.map((p: any) => p.score),
      category: topPredictions[0]?.label,
    };
  } catch (error) {
    logger.warn("AI analysis error", { error });
    return null;
  }
}
