/**
 * Notification Template Engine Tests
 *
 * Tests for api-v1-notifications/lib/template-engine.ts
 */

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  clearTemplateCache,
  interpolateTemplate,
  loadTemplate,
} from "../api-v1-notifications/lib/template-engine.ts";

// =============================================================================
// interpolateTemplate Tests
// =============================================================================

Deno.test("interpolateTemplate: replaces all variables", () => {
  const template = "Hello {{username}}, welcome to {{app}}!";
  const result = interpolateTemplate(template, {
    username: "Alice",
    app: "FoodShare",
  });
  assertEquals(result, "Hello Alice, welcome to FoodShare!");
});

Deno.test("interpolateTemplate: handles missing variable - keeps placeholder", () => {
  const template = "Hello {{username}}, your order {{orderId}} is ready.";
  const result = interpolateTemplate(template, {
    username: "Bob",
  });
  assertEquals(result, "Hello Bob, your order {{orderId}} is ready.");
});

Deno.test("interpolateTemplate: handles null/undefined values - keeps placeholder", () => {
  const template = "Value is {{val}}";
  assertEquals(interpolateTemplate(template, { val: null }), "Value is {{val}}");
  assertEquals(interpolateTemplate(template, { val: undefined }), "Value is {{val}}");
});

Deno.test("interpolateTemplate: handles numeric values", () => {
  const template = "You have {{count}} items worth {{price}}";
  const result = interpolateTemplate(template, { count: 5, price: 19.99 });
  assertEquals(result, "You have 5 items worth 19.99");
});

Deno.test("interpolateTemplate: handles boolean values", () => {
  const template = "Active: {{isActive}}";
  assertEquals(interpolateTemplate(template, { isActive: true }), "Active: true");
  assertEquals(interpolateTemplate(template, { isActive: false }), "Active: false");
});

Deno.test("interpolateTemplate: handles whitespace in variable names", () => {
  const template = "Hello {{ username }} and {{  app  }}";
  const result = interpolateTemplate(template, {
    username: "Charlie",
    app: "FoodShare",
  });
  assertEquals(result, "Hello Charlie and FoodShare");
});

Deno.test("interpolateTemplate: no variables returns template as-is", () => {
  const template = "No variables here";
  assertEquals(interpolateTemplate(template, {}), "No variables here");
});

Deno.test("interpolateTemplate: empty template returns empty string", () => {
  assertEquals(interpolateTemplate("", { foo: "bar" }), "");
});

// =============================================================================
// loadTemplate Tests
// =============================================================================

Deno.test("loadTemplate: returns null when template not found", async () => {
  clearTemplateCache();

  const mockQueryBuilder = {
    select: () => mockQueryBuilder,
    eq: () => mockQueryBuilder,
    maybeSingle: async () => ({ data: null, error: null }),
  };

  const mockSupabase = {
    from: () => mockQueryBuilder,
  };

  const result = await loadTemplate(mockSupabase as any, "nonexistent_template");
  assertEquals(result, null);
});

Deno.test("loadTemplate: returns template when found", async () => {
  clearTemplateCache();

  const mockTemplate = {
    id: "tmpl-1",
    name: "welcome",
    type: "welcome",
    title_template: "Welcome {{username}}!",
    body_template: "Hi {{username}}, thanks for joining!",
    channels: ["push", "email"],
    priority: "normal",
    is_active: true,
  };

  const mockQueryBuilder = {
    select: () => mockQueryBuilder,
    eq: () => mockQueryBuilder,
    maybeSingle: async () => ({ data: mockTemplate, error: null }),
  };

  const mockSupabase = {
    from: () => mockQueryBuilder,
  };

  const result = await loadTemplate(mockSupabase as any, "welcome");
  assertEquals(result?.name, "welcome");
  assertEquals(result?.title_template, "Welcome {{username}}!");
});

Deno.test("loadTemplate: cache hit on second call", async () => {
  clearTemplateCache();

  let queryCount = 0;
  const mockTemplate = {
    id: "tmpl-2",
    name: "new_message",
    type: "new_message",
    title_template: "New message from {{sender}}",
    body_template: "{{sender}} says: {{preview}}",
    channels: ["push"],
    priority: "high",
    is_active: true,
  };

  const mockQueryBuilder = {
    select: () => mockQueryBuilder,
    eq: () => mockQueryBuilder,
    maybeSingle: async () => {
      queryCount++;
      return { data: mockTemplate, error: null };
    },
  };

  const mockSupabase = {
    from: () => mockQueryBuilder,
  };

  // First call - hits DB
  const result1 = await loadTemplate(mockSupabase as any, "new_message");
  assertEquals(result1?.name, "new_message");
  assertEquals(queryCount, 1);

  // Second call - should hit cache
  const result2 = await loadTemplate(mockSupabase as any, "new_message");
  assertEquals(result2?.name, "new_message");
  assertEquals(queryCount, 1); // No additional DB call
});

Deno.test("loadTemplate: handles database error gracefully", async () => {
  clearTemplateCache();

  const mockQueryBuilder = {
    select: () => mockQueryBuilder,
    eq: () => mockQueryBuilder,
    maybeSingle: async () => ({
      data: null,
      error: { message: "Connection timeout" },
    }),
  };

  const mockSupabase = {
    from: () => mockQueryBuilder,
  };

  const result = await loadTemplate(mockSupabase as any, "error_template");
  assertEquals(result, null);
});

// =============================================================================
// End-to-End Template Send (integration-style)
// =============================================================================

Deno.test("template + interpolation: end-to-end flow", () => {
  const template = {
    title_template: "New message from {{sender_name}}",
    body_template: '{{sender_name}} sent you a message: "{{message_preview}}"',
  };

  const variables = {
    sender_name: "Alice",
    message_preview: "Hey, is the pasta still available?",
  };

  const title = interpolateTemplate(template.title_template, variables);
  const body = interpolateTemplate(template.body_template, variables);

  assertEquals(title, "New message from Alice");
  assertEquals(body, 'Alice sent you a message: "Hey, is the pasta still available?"');
});
