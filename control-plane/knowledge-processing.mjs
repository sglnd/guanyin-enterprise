export const uploadDefaults = Object.freeze({
  strategy: "structured",
  chunkSize: 1000,
  overlap: 100,
  cleanText: true,
  generateMetadata: true,
});
export const legacyOptions = Object.freeze({
  strategy: "fixed",
  chunkSize: 1600,
  overlap: 0,
  cleanText: false,
  generateMetadata: false,
});
export function processingOptions(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new RangeError("解析设置无效");
  if (Object.keys(input).some((k) => !Object.hasOwn(uploadDefaults, k)))
    throw new RangeError("存在不支持的解析设置");
  const cfg = { ...uploadDefaults, ...input };
  if (!["structured", "fixed"].includes(cfg.strategy))
    throw new RangeError("请选择标题段落切分或固定长度切分");
  if (
    !Number.isInteger(cfg.chunkSize) ||
    cfg.chunkSize < 200 ||
    cfg.chunkSize > 2000
  )
    throw new RangeError("分块长度须为 200～2000 字符");
  if (
    !Number.isInteger(cfg.overlap) ||
    cfg.overlap < 0 ||
    cfg.overlap > Math.floor(cfg.chunkSize / 4)
  )
    throw new RangeError("重叠长度须在 0 到分块长度的 25% 之间");
  if (
    typeof cfg.cleanText !== "boolean" ||
    typeof cfg.generateMetadata !== "boolean"
  )
    throw new RangeError("清洗与摘要设置须为布尔值");
  return cfg;
}
export function savedOptions(input) {
  return input && Object.keys(input).length
    ? processingOptions(input)
    : { ...legacyOptions };
}
export function cleanContent(text) {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .split(/(```[\s\S]*?```|~~~[\s\S]*?~~~)/g)
    .map((s, i) => (i % 2 ? s : s.replace(/\n(?:[ \t]*\n){3,}/g, "\n\n")))
    .join("");
}
export function splitContent(text, input = legacyOptions) {
  const opts = processingOptions(input),
    value = opts.cleanText ? cleanContent(text) : text,
    parts = [];
  let start = 0;
  while (start < value.length) {
    let end = Math.min(value.length, start + opts.chunkSize);
    if (opts.strategy === "structured" && end < value.length) {
      const part = value.slice(start, end),
        floor = Math.floor(opts.chunkSize * 0.55);
      const boundaries = [
        ...part.matchAll(/\n(?=#{1,6}\s)|\n[ \t]*\n|[。！？!?]/g),
      ]
        .map((m) => m.index + m[0].length)
        .filter((n) => n >= floor);
      if (boundaries.length) end = start + boundaries.at(-1);
    }
    if (end < value.length && /[\uDC00-\uDFFF]/.test(value[end])) end--;
    parts.push(value.slice(start, end));
    if (end === value.length) break;
    let next = end - opts.overlap;
    if (next > start && /[\uDC00-\uDFFF]/.test(value[next])) next++;
    start = Math.max(start + 1, next);
  }
  return parts;
}
export function metadataFields(summary, keywords) {
  if (
    typeof summary !== "string" ||
    !summary.trim() ||
    summary.length > 500 ||
    !Array.isArray(keywords) ||
    !keywords.length ||
    keywords.length > 10 ||
    keywords.some((k) => typeof k !== "string" || !k.trim() || k.length > 30)
  )
    throw new RangeError(
      "摘要须为 1～500 字，关键词须为 1～10 个且每个不超过 30 字",
    );
  return {
    summary: summary.trim(),
    keywords: [...new Set(keywords.map((k) => k.trim()))],
  };
}

export function generationPolicy(input = {}) {
  const draftMaxTokens =
    input.draftMaxTokens === undefined ? 16000 : input.draftMaxTokens;
  const draftRetryMaxTokens =
    input.draftRetryMaxTokens === undefined ? 32000 : input.draftRetryMaxTokens;
  for (const value of [draftMaxTokens, draftRetryMaxTokens])
    if (!Number.isInteger(value) || value < 1000 || value > 64000)
      throw new RangeError("整理预算须为 1000～64000 的整数");
  if (draftRetryMaxTokens < draftMaxTokens)
    throw new RangeError("自动重试预算不能小于首次整理预算");
  return { draftMaxTokens, draftRetryMaxTokens };
}
