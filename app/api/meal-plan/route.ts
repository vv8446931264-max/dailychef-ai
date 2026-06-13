import { GoogleGenerativeAI } from "@google/generative-ai";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

const RequestSchema = z.object({
  preferences: z.string().min(1).max(500),
  budget: z.number().min(1).max(10000),
  people: z.number().min(1).max(20),
  dietaryRestrictions: z.string().max(200).optional(),
});

const MealSchema = z.object({
  name: z.string(),
  description: z.string(),
  prepTime: z.string(),
  cookingSteps: z.array(z.string()),
  calories: z.number().min(0).max(5000),
});

const GroceryItemSchema = z.object({
  item: z.string(),
  quantity: z.string(),
  estimatedCost: z.number().min(0).max(1000),
  category: z.enum(["produce", "protein", "dairy", "grains", "pantry", "other"]),
});

const SubstitutionSchema = z.object({
  original: z.string(),
  substitute: z.string(),
  reason: z.string(),
});

const MealPlanSchema = z.object({
  breakfast: MealSchema,
  lunch: MealSchema,
  dinner: MealSchema,
  groceryList: z.array(GroceryItemSchema).min(1).max(30),
  substitutions: z.array(SubstitutionSchema).min(1).max(5),
  budgetBreakdown: z.object({
    estimated: z.number().min(0),
    withinBudget: z.boolean(),
    savingsTip: z.string(),
  }),
  cookingTodos: z.array(z.string()).min(1).max(20),
});

export type MealPlan = z.infer<typeof MealPlanSchema>;

const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  if (entry.count >= 5) return false;
  entry.count++;
  return true;
}

const requestCache = new Map<string, { data: MealPlan; expiresAt: number }>();

async function callGemini(prompt: string, apiKey: string): Promise<MealPlan> {
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

  const systemPrompt = `You are a professional meal planner and chef assistant. Generate a structured daily meal plan as valid JSON only.
Return ONLY a JSON object matching this exact structure — no markdown, no explanation:
{
  "breakfast": { "name": string, "description": string, "prepTime": string, "cookingSteps": string[], "calories": number },
  "lunch": { "name": string, "description": string, "prepTime": string, "cookingSteps": string[], "calories": number },
  "dinner": { "name": string, "description": string, "prepTime": string, "cookingSteps": string[], "calories": number },
  "groceryList": [{ "item": string, "quantity": string, "estimatedCost": number, "category": "produce"|"protein"|"dairy"|"grains"|"pantry"|"other" }],
  "substitutions": [{ "original": string, "substitute": string, "reason": string }],
  "budgetBreakdown": { "estimated": number, "withinBudget": boolean, "savingsTip": string },
  "cookingTodos": string[]
}`;

  const result = await model.generateContent(`${systemPrompt}\n\nUser request: ${prompt}`);
  const text = result.response.text().trim();

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("No JSON in response");

  const parsed = JSON.parse(jsonMatch[0]);
  return MealPlanSchema.parse(parsed);
}

export async function POST(req: NextRequest) {
  const ip = req.headers.get("x-forwarded-for") ?? "unknown";

  if (!checkRateLimit(ip)) {
    return NextResponse.json({ error: "Rate limit exceeded. Try again in a minute." }, { status: 429 });
  }

  const contentLength = req.headers.get("content-length");
  if (contentLength && parseInt(contentLength) > 10_000) {
    return NextResponse.json({ error: "Request too large." }, { status: 413 });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "Server configuration error." }, { status: 500 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const parsed = RequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input." }, { status: 400 });
  }

  const { preferences, budget, people, dietaryRestrictions } = parsed.data;
  const cacheKey = `${preferences}|${budget}|${people}|${dietaryRestrictions ?? ""}`;

  const cached = requestCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    return NextResponse.json({ plan: cached.data, cached: true });
  }

  const prompt = `Preferences: ${preferences}. Budget: $${budget} for ${people} people. Dietary restrictions: ${dietaryRestrictions || "none"}.`;

  let plan: MealPlan;
  try {
    plan = await callGemini(prompt, apiKey);
  } catch (firstErr) {
    // One self-correcting retry
    try {
      plan = await callGemini(prompt + " Ensure response is valid JSON only.", apiKey);
    } catch {
      console.error("Gemini failed:", firstErr);
      return NextResponse.json({ error: "Failed to generate meal plan. Please try again." }, { status: 502 });
    }
  }

  requestCache.set(cacheKey, { data: plan, expiresAt: Date.now() + 5 * 60_000 });

  return NextResponse.json({ plan, cached: false });
}
