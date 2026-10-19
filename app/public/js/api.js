// Thin fetch wrapper: JSON in/out, cookies, friendly errors, 401 -> /login.
// Never leaves a page stuck on "Se incarca..." - network/server failures always reject
// with a human-readable Romanian message.

async function request(method, url, body, opts = {}) {
  let res;
  try {
    res = await fetch(url, {
      method,
      credentials: "same-origin",
      headers: (body instanceof FormData || body instanceof Blob) ? {} : { "Content-Type": "application/json" },
      body: body == null ? undefined : ((body instanceof FormData || body instanceof Blob) ? body : JSON.stringify(body)),
    });
  } catch (e) {
    throw new ApiError("Eroare de rețea. Verifică conexiunea și reîncearcă.", 0, null);
  }

  if (res.status === 401 && !opts.allow401) {
    if (location.pathname !== "/login") location.href = "/login";
    throw new ApiError("Neautentificat", 401, null);
  }

  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("application/json")) {
    if (opts.raw) return res; // caller wants the raw Response (file download etc.)
    if (res.ok) return null;
    if (res.status === 413) throw new ApiError("Fișierul e prea mare pentru încărcare.", 413, null);
    throw new ApiError("Serverul nu răspunde, reîncearcă.", res.status, null);
  }

  let data;
  try {
    data = await res.json();
  } catch (e) {
    throw new ApiError("Serverul nu răspunde, reîncearcă.", res.status, null);
  }

  if (!res.ok) {
    const err = new ApiError(data.error || "Eroare necunoscută", res.status, data.article || null, data.code || null, data.errors || null);
    err.data = data; // extra fields (e.g. expected_seq on a chunk 409)
    throw err;
  }
  return data;
}

class ApiError extends Error {
  constructor(message, status, article, code, fieldErrors) {
    super(message);
    this.status = status;
    this.article = article;
    this.code = code;
    this.fieldErrors = fieldErrors || null;
  }
}

const api = {
  get: (url, opts) => request("GET", url, null, opts),
  post: (url, body, opts) => request("POST", url, body, opts),
  put: (url, body, opts) => request("PUT", url, body, opts),
  patch: (url, body, opts) => request("PATCH", url, body, opts),
  del: (url, body, opts) => request("DELETE", url, body, opts),
  upload: (url, formData, opts) => request("POST", url, formData, opts),
};

export { api, ApiError };
