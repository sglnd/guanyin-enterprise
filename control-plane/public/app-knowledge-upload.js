export function validateUploadFile(file) {
  if (!file.name || file.name.length > 120 || /[\/\\\x00-\x1f]/.test(file.name))
    return "文件名无效或超过 120 字";
  if (!/\.(docx|xlsx|pdf|txt|md)$/i.test(file.name))
    return "不支持的格式，请选择 DOCX、XLSX、PDF、TXT 或 Markdown";
  if (!file.size) return "文件为空";
  if (file.size > 10485760) return "文件超过 10MB";
  return "";
}
export function newUploadId() {
  if (globalThis.crypto.randomUUID) return globalThis.crypto.randomUUID();
  const b = globalThis.crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 15) | 64;
  b[8] = (b[8] & 63) | 128;
  const s = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}
export function uploadKnowledgeFile(
  url,
  {
    file,
    requestId,
    options,
    onProgress = () => {},
    onTransferred = () => {},
    signal,
  },
) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("上传已取消", "AbortError"));
      return;
    }
    const xhr = new XMLHttpRequest();
    let done = false;
    const abort = () => xhr.abort();
    const finish = (error, result) => {
      if (done) return;
      done = true;
      signal?.removeEventListener("abort", abort);
      error ? reject(error) : resolve(result);
    };
    xhr.open("POST", url, true);
    xhr.withCredentials = true;
    xhr.timeout = 120000;
    xhr.setRequestHeader("content-type", "application/octet-stream");
    xhr.setRequestHeader("x-file-name", encodeURIComponent(file.name));
    xhr.setRequestHeader("x-upload-id", requestId);
    xhr.setRequestHeader(
      "x-knowledge-options",
      encodeURIComponent(JSON.stringify(options)),
    );
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable)
        onProgress(Math.min(100, Math.round((e.loaded / e.total) * 100)));
    };
    xhr.upload.onload = () => onTransferred();
    xhr.onload = () => {
      let result;
      try {
        result = JSON.parse(xhr.responseText);
      } catch {
        finish(Error("上传响应无法确认，请重试核对原上传记录"));
        return;
      }
      if (xhr.status < 200 || xhr.status >= 300) {
        const error = Error(result.error || `上传失败（${xhr.status}）`);
        error.status = xhr.status;
        finish(error);
        return;
      }
      if (!result.id || !Number.isInteger(result.version)) {
        finish(Error("上传结果不完整，请重试核对原上传记录"));
        return;
      }
      finish(null, result);
    };
    xhr.onerror = () =>
      finish(Error("上传连接中断，请重试；服务端会核对上传标识"));
    xhr.ontimeout = () =>
      finish(Error("上传超时，请重试；服务端会核对上传标识"));
    xhr.onabort = () => finish(new DOMException("上传已取消", "AbortError"));
    signal?.addEventListener("abort", abort, { once: true });
    try {
      xhr.send(file);
    } catch (error) {
      finish(error);
    }
  });
}
