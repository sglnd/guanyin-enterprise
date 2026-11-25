import test from "node:test";
import assert from "node:assert/strict";
import { wikiPreview } from "../public/app-knowledge.js";
test("Wiki preview formats content without executing document HTML or loading remote assets", () => {
  const out = wikiPreview(
    '# 操作手册\n\n- **确认** `磁盘`\n<script>alert(1)</script>\n<img src=x onerror=alert(1)>\n[链接](javascript:alert(1))\n```html\n<iframe src="https://invalid.example"></iframe>',
  );
  assert.match(out, /<h1>操作手册<\/h1>/);
  assert.match(out, /<strong>确认<\/strong>/);
  assert.match(out, /<code>磁盘<\/code>/);
  assert(!/<(?:script|img|iframe|a)\b/.test(out));
  assert.match(out, /&lt;script&gt;/);
  assert(out.endsWith("</code></pre>"));
});

test("Wiki tables and code stay escaped", () => {
  const out = wikiPreview('| 检查项 | 结果 |\n| --- | --- |\n| **容量** | `df` |\n| a\\|b | <img src=x> |\n\n~~~sh\n<script>\n~~~');
  assert.match(out, /<th>检查项<\/th>/);
  assert.match(out, /<td><strong>容量<\/strong><\/td>/);
  assert.match(out, /<td>a\|b<\/td>/);
  assert(!/<(?:img|script)\b/.test(out));
  assert.match(out, /<pre><code>&lt;script&gt;\n<\/code><\/pre>/);

});
